/* Paragraphs for Korean feed text and evidence (docs/feed-writing-guide.md).
 * Writers' line breaks always win. Text without them is split only at sentence
 * ends, so joining the result with spaces gives back the whitespace-collapsed
 * input: nothing is reworded, dropped or reordered.
 * Method: a dynamic program picks the break set whose paragraph widths sit
 * closest to TARGET, plus "glue" costs that keep back-references, continuations
 * and short qualifiers with the sentence they depend on. The rules were chosen
 * by blind side-by-side judging on the published records.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MonitorText = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ---- Tunables. Widths are in Hangul-syllable units (see width()). ----
  // The desktop feed column holds ~45 units per line, the mobile column ~18.
  const SINGLE_MAX = 120;   // ~2.7 desktop / ~6.7 mobile lines: keep whole.
  const TARGET = 85;        // ~1.9 desktop / ~4.7 mobile lines per paragraph.
  const MIN_PARA = 40;      // under ~1 desktop line reads as a fragment: never emitted.
  const PARA_COST = 0.04;   // per paragraph, so ties go to fewer paragraphs.
  const MAX_SENT = 3, OVER_SENT = 0.08; // gentle push away from 4+ sentences.
  const HARD = 3;           // back-reference glue; gives way only past ~220 width.
  const SOFT = 0.35;        // qualifier glue; tips close calls only.
  const ALSO_COST = 0.12;   // "X도 …" enumeration nudge.
  const SHIFT_BONUS = 0.1;  // "한편/별도로" opener.
  const SWITCH_BONUS = 0.15; // subject moves to another source family.
  const CLOSING_BONUS = 0.3; // whole-item closing caveat as its own paragraph.
  const EXPLICIT_LONG = 2 * SINGLE_MAX; // a writer's block wider than this is still split.

  const ABBR = new Set(['U.S.', 'Inc.', 'Corp.', 'Co.', 'Ltd.', 'Jr.', 'Sr.', 'Mr.', 'Ms.', 'Mrs.',
    'Dr.', 'St.', 'No.', 'Prof.', 'Gov.', 'Sen.', 'Rep.', 'Gen.', 'Mt.', 'Fig.', 'Vol.', 'Jan.', 'Feb.',
    'Mar.', 'Apr.', 'Jun.', 'Jul.', 'Aug.', 'Sep.', 'Sept.', 'Oct.', 'Nov.', 'Dec.']);
  // Case-insensitive only for Latin-phrase abbreviations ("EST." must stay a real end).
  // "v." covers case names such as "Purcell v. Gonzalez".
  const ABBR_ANYCASE = new Set(['e.g.', 'i.e.', 'vs.', 'v.', 'etc.', 'cf.', 'approx.']);
  const CLOSERS = '["\'”’)\\]」』>]';
  const CLOSER_SET = new Set(['"', '\'', '”', '’', ')', ']', '」', '』', '>']);
  // Opening quotes and brackets with the character that closes them. Straight
  // double quotes toggle; ’ closes only an open ‘, since it is also an apostrophe.
  const PAIRS = Object.freeze({ '“': '”', '‘': '’', '「': '」', '『': '』', '(': ')', '[': ']' });

  function width(s) {
    let w = 0;
    for (const ch of s) {
      const c = ch.codePointAt(0);
      if (c === 0x20) w += 0.3;
      else if (c < 0x80) w += /[A-Za-z0-9]/.test(ch) ? 0.6 : 0.35;
      else w += c >= 0x1100 ? 1 : 0.6; // Hangul, CJK, full-width : other
    }
    return w;
  }

  // True when the "." ending this Latin token is an abbreviation or initial.
  function isAbbrev(tok) {
    return ABBR.has(tok) || ABBR_ANYCASE.has(tok.toLowerCase()) ||
      /^[A-Z]\.$/.test(tok) || /^(?:[A-Za-z]{1,3}\.){2,}$/.test(tok); // "J.", "U.K.", "Ph.D."
  }

  // A token of 1-4 digits followed by "." that belongs to a dotted date such as
  // "2026. 11. 4." (the token before or after it is also a dotted number).
  function inDottedDate(s, tokStart, dot) {
    if (!/^\d{1,4}$/.test(s.slice(tokStart, dot))) return false;
    const before = s.slice(s.lastIndexOf(' ', tokStart - 2) + 1, Math.max(0, tokStart - 1));
    return /^\d{1,4}\.$/.test(before) || /^ \d{1,2}\./.test(s.slice(dot + 1, dot + 5));
  }

  // Sentences of one whitespace-collapsed block: they end at . ? ! (plus closing
  // quotes or brackets) followed by a space, but never inside an open quotation
  // or bracket. One linear pass, so long runs of punctuation cannot stall it.
  function splitSentences(s) {
    const out = [];
    const open = []; // closers expected for the quotes and brackets now open
    let straight = false; // inside an ASCII "…" quote
    let single = false;   // inside an ASCII '…' quote
    let start = 0;
    // An ASCII ' opens a quote at the start of a word and closes it unless a Latin
    // letter or digit follows, so apostrophes such as "Binance's" are ignored.
    const track = k => {
      const ch = s[k];
      if (ch === '"') straight = !straight;
      else if (ch === '\'') {
        if (!single && /[\s(\[“‘"]/.test(k ? s[k - 1] : ' ') && s[k + 1] && s[k + 1] !== ' ') single = true;
        else if (single && !/[A-Za-z0-9]/.test(s[k + 1] || '')) single = false;
      } else if (PAIRS[ch]) open.push(PAIRS[ch]);
      else if (open.length && ch === open[open.length - 1]) open.pop();
    };
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch !== '.' && ch !== '?' && ch !== '!') { track(i); continue; }
      let end = i;
      let periodsOnly = true;
      while (end < s.length && '.?!'.includes(s[end])) { if (s[end] !== '.') periodsOnly = false; end++; }
      while (end < s.length && CLOSER_SET.has(s[end])) track(end++);
      const boundary = s[end] === ' ' && !open.length && !straight && !single;
      i = end - 1;
      if (!boundary) continue;
      if (periodsOnly) {
        const tokStart = s.lastIndexOf(' ', end - 1) + 1;
        const core = s.slice(tokStart, end).replace(/^[("'“‘[「『<]+/, '');
        if (isAbbrev(core)) continue;                                      // bare token only
        if (tokStart === start && /^\(?\d{1,2}\.$/.test(core)) continue;   // "1. " list marker
        if (inDottedDate(s, tokStart, s.indexOf('.', tokStart))) continue; // "2026. 11. 4."
      }
      out.push(s.slice(start, end));
      start = end + 1;
    }
    if (start < s.length) out.push(s.slice(start));
    return out;
  }

  // ---- Glue: the cost of starting a paragraph with `sent` right after `prev`. ----
  // Back-references, connectives, "same/each/both" words and qualifiers of the
  // figure just stated point at the previous sentence.
  const HARD_START = new RegExp('^(?:' + [
    '이[는를에와로가]\\s', '이것', '이같', '이 같은', '이 때문', '이로써', '이러한', '이런', '이들', '이\\s',
    '그[는가를의]?\\s', '그러나', '그런데', '그래서', '그러므로', '그리고', '하지만', '다만', '단[,\\s]',
    '또[,\\s]', '또한', '또는', '따라서', '즉[,\\s]', '반면', '특히', '아울러', '게다가', '대신',
    '같은\\s', '앞선\\s', '앞의\\s', '위\\s', '해당\\s', '각각', '각\\s', '모두\\s', '둘 다', '두\\s[^\\d]',
    '세\\s(?:건|곳|개|경주|값|수치)', '이번\\s(?:사례|결과|수치|판단|변화)', '나머지',
    '한국시간[은으는]', 'KST[는로]', 'UTC[로는]\\s', '조회보다', '조회 당시', '전일 대비',
    '약\\s?\\d', '단일 관측', '표시\\s', '시간대 미확인',
  ].join('|') + ')');
  // "앞선 세 건은" names what it refers to, so it may open a paragraph (soft glue only).
  const COUNTED_REF = /^앞선\s(?:두|세|네|다섯|\d+)\s/;
  // "한국시간 11:57에는 …" converts a foreign time only when the previous sentence has one.
  const KST_OPEN = /^한국시간\s?\d/;
  const FOREIGN_TIME = /\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?\s?(?:UTC|E[SD]T|P[SD]T|C[SD]T|CET|AEDT|GMT)|(?:UTC|EST|PST|CET)\d/;
  // "…도 같다/동일하다/유지됐다/남아 있다": continues the claim before it.
  const NOT_ALSO = '[^\\s정속제태인지온한강빈각의용시]'; // nouns that merely end in 도
  const CONTINUES = new RegExp(`\\S${NOT_ALSO}도\\s.*(?:같다|동일하다|마찬가지다|유지됐다|유지된다|유지했다|남아 있다)\\.$`);
  // "…남아 있어/…므로 … 않는다": a conclusion drawn from the lines before it.
  const CONSEQUENCE = /(?:남아 있어|있으므로|없으므로|때문에)\s.*(?:않는다|않았다|없다|어렵다)\.$/;
  const SOFT_START = /^(?:이전|이후|기존 기록|직전|(?:전체\s)?(?:표시\s)?합계|총\s?합계|격차는|차이는|득표율은)\s?/;
  // A short sentence ending in a negative judgement qualifies the fact before it.
  const SOFT_END = /(?:알 수 없다|확인되지 않았다|끝나지 않았다|못 미쳤다|아니다|아님|아닌 것이다|미확인(?:이다)?|미달이다|미완료(?:다)?|유보한다|구분한다|구분|(?:판단|표현|해석|사용|취급)하지 않는다|쓰지 않는다|혼합하지 않았다|의미하지 않음|뜻하지 않(?:음|는다))\.$/;
  const ALSO = new RegExp(`^(?:\\S+\\s){0,3}?\\S*${NOT_ALSO}도\\s|\\S${NOT_ALSO}도\\s\\S+\\.$`);
  // A predicate-less data line ("USDT 0.998(-15bp), USDC 0.999(-2bp).") continues a
  // list; query-time headers ("조회 10:53 UTC.") are exempt.
  const DATA_TAIL = /[0-9%)\]]\.$/;
  const HEADER = /^(?:실제\s?)?조회|^(?:\d{1,2}월\s?\d{1,2}일\s?)?\d{1,2}:\d{2}/;
  const SHIFT = /^(?:한편|반면에|이와 별도로|별도로|별도)[,\s]/;
  // A last sentence that scopes the whole item reads best as a closing paragraph.
  const CLOSING = /^(?:이번 (?:공개자료|실행|점검|조회)|공개 표본에 한정)|전체 \S+[을를]? 뜻하지 않/;
  // Source families: a change of family is a natural seam (market data -> operations).
  const FAMILIES = [
    /^(?:VIX|DXY|FRED|CMC|OKX|Cboe|MarketWatch|S&P|SOFR|OAS|BTC|ETH|USDT|USDC|금리|국채|\d+년물)(?![A-Za-z])/,
    /^(?:Coinbase|Circle|GitHub|GitBook|Binance|Mercado|BTCPay|Chainalysis|Kraken|Bybit|BitMart)(?![A-Za-z])/,
  ];
  function family(sent) {
    for (const tok of sent.split(' ').slice(0, 3)) {
      const k = FAMILIES.findIndex(re => re.test(tok));
      if (k >= 0) return k;
    }
    return -1;
  }

  // Korean drops a subject repeated from the previous sentence: a verb-final
  // sentence with no subject- or topic-marked word continues it.
  // Trailing characters are trimmed with a backward loop: a regex anchored only at
  // the end retries from every offset and turns quadratic on long runs.
  function trimTrailing(s, keep) {
    let end = s.length;
    while (end > 0 && !keep(s[end - 1])) end--;
    return s.slice(0, end);
  }
  const isWordChar = ch => /[\p{L}\p{N}]/u.test(ch);

  function subjectless(sent) {
    if (!/다\.$/.test(sent)) return false;
    const toks = sent.split(' ').slice(0, -1).map(t => trimTrailing(t, isWordChar));
    return !toks.some(t => /(?:은|는|이|가|도|께서|에서|에선)$/.test(t));
  }

  // The splitter's boundary may be false: "(U.S.)", "Ph.D.", "Nov." at the end of
  // a token, an inline "1." list number, or a quote continued by a quotative particle.
  function weakBoundary(prev, sent) {
    const tail = trimTrailing(prev, ch => !CLOSER_SET.has(ch));
    const tok = tail.slice(Math.max(tail.lastIndexOf(' '), tail.lastIndexOf('('), tail.lastIndexOf('[')) + 1);
    if (isAbbrev(tok)) return true;
    if (/^\d{1,2}\.$/.test(tok) && tail.length > tok.length) return true;
    return /["'”’]$/.test(prev) && /^(?:라고|이라고|고|라며|며|란|이란|하고)(?:\s|$)/.test(sent);
  }

  function glueCost(sent, prev, isLast) {
    if (weakBoundary(prev, sent)) return Infinity;
    if (SHIFT.test(sent)) return -SHIFT_BONUS;
    if (isLast && CLOSING.test(sent)) return -CLOSING_BONUS;
    const switched = family(sent) >= 0 && family(prev) >= 0 && family(sent) !== family(prev);
    if (COUNTED_REF.test(sent)) return SOFT;
    if (HARD_START.test(sent)) return HARD;
    if (KST_OPEN.test(sent) && FOREIGN_TIME.test(prev)) return HARD;
    if (!switched && (CONTINUES.test(sent) || CONSEQUENCE.test(sent))) return HARD;
    let c = switched ? -SWITCH_BONUS : 0;
    if (SOFT_START.test(sent)) c += SOFT;
    if (SOFT_END.test(sent) && width(sent) < 45) c += SOFT;
    if (ALSO.test(sent)) c += ALSO_COST;
    if (subjectless(sent)) c += SOFT;
    if (DATA_TAIL.test(sent) && !/다\.$/.test(sent) && !HEADER.test(sent)) c += SOFT;
    return c;
  }

  function paraCost(w, nSent) {
    const d = (w - TARGET) / TARGET;
    return d * d + PARA_COST + Math.max(0, nSent - MAX_SENT) * OVER_SENT;
  }

  // Split one whitespace-collapsed block.
  function autoSplit(s) {
    const sents = splitSentences(s);
    const n = sents.length;
    if (n <= 1 || width(s) <= SINGLE_MAX) return [s];
    const pre = [0];
    for (let i = 0; i < n; i++) pre.push(pre[i] + width(sents[i]) + (i ? 0.3 : 0));
    const widthOf = (i, j) => pre[j] - pre[i] - (i ? 0.3 : 0); // sentences i..j-1
    const glue = sents.map((x, i) => (i ? glueCost(x, sents[i - 1], i === n - 1) : 0));

    const best = new Array(n + 1).fill(Infinity), from = new Array(n + 1).fill(-1);
    best[0] = 0;
    for (let j = 1; j <= n; j++) {
      for (let i = 0; i < j; i++) {
        const w = widthOf(i, j);
        if (best[i] === Infinity || (w < MIN_PARA && !(i === 0 && j === n))) continue;
        const c = best[i] + glue[i] + paraCost(w, j - i);
        if (c < best[j]) { best[j] = c; from[j] = i; }
      }
    }
    if (best[n] === Infinity) return [s];
    const out = [];
    for (let j = n; j > 0; j = from[j]) out.unshift(sents.slice(from[j], j).join(' '));
    return out;
  }

  const LINE_END = new RegExp(`[.?!:]${CLOSERS}*$`);
  const LIST_ITEM = /^(?:[-*•·▪◦]|\d{1,2}[.)])\s/;

  function normalized(text) {
    return (text == null ? '' : String(text)).replace(/\r\n?|\u2028/g, '\n').replace(/\u2029/g, '\n\n').trim();
  }

  // Writer-authored blocks. A blank line always ends a paragraph; a single newline
  // does too after terminal punctuation or before a list item. Any other single
  // newline is a soft wrap inside a sentence and becomes a space.
  function writerBlocks(raw) {
    const blocks = [];
    for (const chunk of raw.split(/\n[ \t\f\v]*\n\s*/)) {
      let cur = '';
      for (const line of chunk.split('\n').map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean)) {
        if (cur && (LINE_END.test(cur) || LIST_ITEM.test(line))) { blocks.push(cur); cur = line; }
        else cur = cur ? `${cur} ${line}` : line;
      }
      if (cur) blocks.push(cur);
    }
    return blocks;
  }

  function blocksOf(raw) {
    return raw.includes('\n') ? writerBlocks(raw) : [raw.replace(/\s+/g, ' ')];
  }

  // A text that forms one block (no newline, or only soft wraps) is split
  // automatically; writer paragraphs stay, unless one is wider than EXPLICIT_LONG.
  function paragraphs(text) {
    const raw = normalized(text);
    if (!raw) return [];
    const blocks = blocksOf(raw);
    if (blocks.length === 1) return autoSplit(blocks[0]);
    return blocks.flatMap(b => (width(b) > EXPLICIT_LONG ? autoSplit(b) : [b]));
  }

  // Sentences in reading order, with the boundaries paragraphs() can break at:
  // pieces split at a false boundary ("(U.S.)", "Ph.D.", a quotative particle)
  // are joined back to the sentence they belong to.
  function sentences(text) {
    const raw = normalized(text);
    if (!raw) return [];
    return blocksOf(raw).flatMap(block => splitSentences(block).reduce((joined, piece) => {
      if (joined.length && weakBoundary(joined[joined.length - 1], piece)) joined[joined.length - 1] += ` ${piece}`;
      else joined.push(piece);
      return joined;
    }, []));
  }

  return Object.freeze({ paragraphs, sentences, width });
});
