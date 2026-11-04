/* Lossless presentation only. The five publisher keys and JSON contracts stay independent. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MonitorView = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const SECURITY_NAME = '크립토 보안·해킹';
  const SUBTYPES = Object.freeze({ security: '사건·복구', onchain: 'ZachXBT 조사·자금 추적' });
  // Fixed feed signal vocabulary (docs/feed-writing-guide.md). A kind outside
  // this list is still shown, as a plain label without signal styling.
  const KIND_STYLES = Object.freeze({ '새 사실': 'k-new', '정정': 'k-new', '누락 보완': 'k-base', '참고': 'k-note',
    '확인 제한': 'k-quiet', '변화 없음': 'k-quiet', '기준점': 'k-base', '감시 설정': 'k-set' });
  const KIND_RANK = Object.freeze({ '새 사실': 0, '정정': 0, '감시 설정': 1, '기준점': 2, '누락 보완': 2, '참고': 3,
    '확인 제한': 3, '변화 없음': 4 });
  const displayKey = key => key === 'onchain' ? 'security' : key;
  const subtype = key => SUBTYPES[key] || '';
  const matches = (item, key) => key === 'all' || displayKey(item.category) === displayKey(key);

  function categories(data) {
    const groups = new Map();
    for (const c of data.categories || []) {
      const key = displayKey(c.key);
      if (!groups.has(key)) groups.set(key, { key, name: key === 'security' ? SECURITY_NAME : c.name,
        color: key === 'security' ? '#F0B429' : c.color, members: [] });
      groups.get(key).members.push(c);
    }
    for (const group of groups.values()) group.members.sort((a, b) =>
      (a.key === 'security' ? 0 : 1) - (b.key === 'security' ? 0 : 1));
    return [...groups.values()];
  }

  // Group only clearly named subjects. Roundups mentioning multiple subjects
  // and unnamed investigations remain separate. These are related records,
  // never an inferred count of incidents or a combined loss/recovery amount.
  const SUBJECTS = [
    ['binance', 'Binance', /\bBinance\b|바이낸스/i],
    ['gitbook', 'GitBook', /\bGitBook\b|깃북/i],
    ['mercado', 'Mercado Bitcoin', /\bMercado(?:\s+Bitcoin)?\b|메르카도/i],
    ['btcpay', 'BTCPay', /\bBTCPay(?:\s+Server)?\b/i],
    ['chainalysis', 'Chainalysis', /\bChainalysis\b/i],
  ];
  function subject(item) {
    if (!subtype(item.category) || item.isQuiet) return null;
    const title = SUBJECTS.filter(([, , pattern]) => pattern.test(item.title || ''));
    const body = SUBJECTS.filter(([, , pattern]) => pattern.test(item.text || ''));
    // A single-subject title cannot turn a multi-subject roundup into one case.
    if (body.length > 1 || title.length > 1) return null;
    const found = title.length ? title : body;
    return found.length === 1 && (!body.length || !title.length || body[0][0] === title[0][0]) ? found[0] : null;
  }
  function groupFeed(items) {
    const groups = [];
    const named = new Map();
    const sorted = items.slice().sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
    for (const item of sorted) {
      const match = subject(item);
      let group = match && named.get(match[0]);
      if (!group) {
        group = { key: match ? match[0] : '', label: match ? match[1] : '', records: [] };
        groups.push(group);
        if (match) named.set(match[0], group);
      }
      group.records.push(item);
    }
    return groups;
  }
  // Reader-facing names for source hosts. Unknown hosts fall back to the bare
  // hostname, so a new source never breaks the list or hides its origin.
  const SOURCE_NAMES = [
    [/(?:^|\.)okx\.com$/, 'OKX'],
    [/(?:^|\.)coinmarketcap\.com$/, 'CoinMarketCap'],
    [/(?:^|\.)decisiondeskhq\.com$/, 'DDHQ'],
    [/^fred\.stlouisfed\.org$/, 'FRED'],
    [/(?:^|\.)marketwatch\.com$/, 'MarketWatch'],
    [/(?:^|\.)cboe\.com$/, 'Cboe'],
    [/(?:^|\.)eia\.gov$/, 'EIA'],
    [/(?:^|\.)frbservices\.org$/, 'FRB Services'],
    [/^status\.coinbase\.com$/, 'Coinbase 상태'],
    [/^status\.circle\.com$/, 'Circle 상태'],
    [/^status\.kraken\.com$/, 'Kraken 상태'],
    [/^status\.solana\.com$/, 'Solana 상태'],
    [/^status\.mercadobitcoin\.com\.br$/, 'Mercado Bitcoin 상태'],
    [/(?:^|\.)gitbookstatus\.com$/, 'GitBook 상태'],
    [/(?:^|\.)githubstatus\.com$/, 'GitHub 상태'],
    [/(?:^|\.)gitbook\.com$/, 'GitBook'],
    [/(?:^|\.)binance\.com$/, 'Binance'],
    [/(?:^|\.)chainalysis\.com$/, 'Chainalysis'],
    [/(?:^|\.)btcpayserver\.org$/, 'BTCPay'],
    [/(?:^|\.)bitquery\.io$/, 'Bitquery'],
    [/(?:^|\.)cm-arkea\.com$/, 'Crédit Mutuel Arkéa'],
    [/^forum\.arbitrum\.foundation$/, 'Arbitrum 포럼'],
    [/(?:^|\.)(?:x|twitter)\.com$/, 'X'],
    [/^t\.me$/, 'Telegram'],
    [/(?:^|\.)theguardian\.com$/, 'Guardian'],
    [/(?:^|\.)cointelegraph\.com$/, 'Cointelegraph'],
    [/(?:^|\.)ca9\.uscourts\.gov$/, '제9연방항소법원'],
    [/(?:^|\.)ncsbe\.gov$/, 'North Carolina 선관위'],
    [/(?:^|\.)crotononhudson-ny\.gov$/, 'Croton-on-Hudson'],
    [/(?:^|\.)hawaii\.gov$/, 'Hawaii 주정부'],
    [/(?:^|\.)sos\.state\.tx\.us$/, 'Texas 주정부'],
    [/(?:^|\.)sos\.ks\.gov$/, 'Kansas 주정부'],
    [/(?:^|\.)sos\.mn\.gov$/, 'Minnesota 주정부'],
    [/(?:^|\.)nebraska\.gov$/, 'Nebraska 주정부'],
  ];
  function sourceInfo(url) {
    let u;
    try { u = new URL(url); } catch (_) { return { url, name: String(url || ''), detail: '', api: false }; }
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    const known = SOURCE_NAMES.find(([pattern]) => pattern.test(host));
    let detail = `${u.pathname.replace(/\/+$/, '')}${u.search}`;
    try { detail = decodeURIComponent(detail); } catch (_) { /* keep the encoded path */ }
    return { url, name: known ? known[1] : host, detail, api: /\/api\//i.test(u.pathname) };
  }
  // Sentences end at . ! ? followed by whitespace, except after an abbreviation
  // or a single initial ("U.S. 하원", "J. Smith"). A newline always ends one.
  const NOT_SENTENCE_END = /(?:^|[^A-Za-z.])(?:U\.S|U\.K|e\.g|i\.e|vs|Inc|Corp|Co|Ltd|Jr|Sr|Mr|Ms|Mrs|Dr|St|No|[A-Z])\.$/;
  function sentences(text) {
    const result = [];
    for (const line of String(text || '').split(/\n+/)) {
      const boundary = /[.!?]+(?=\s)/g;
      let start = 0;
      let m;
      while ((m = boundary.exec(line))) {
        const end = m.index + m[0].length;
        if (NOT_SENTENCE_END.test(line.slice(start, end))) continue;
        const sentence = line.slice(start, end).trim();
        if (sentence) result.push(sentence);
        start = end;
      }
      const rest = line.slice(start).trim();
      if (rest) result.push(rest);
    }
    return result;
  }
  // Paragraphs for feed text and evidence. Writers' newlines always win; text
  // without newlines is split only at sentence boundaries, never rewritten.
  function paragraphs(text) {
    const raw = String(text || '');
    if (/\n/.test(raw)) return raw.split(/\n+/).map(p => p.replace(/\s+/g, ' ').trim()).filter(Boolean);
    const all = sentences(raw);
    if (all.length < 3) return all.length ? [raw.replace(/\s+/g, ' ').trim()] : [];
    const result = [];
    for (let i = 0; i < all.length; i += 2) result.push(all.slice(i, i + 2).join(' '));
    return result;
  }
  // One summary per record: distinct source names in first-seen order.
  function sourceSummary(urls) {
    const sources = (urls || []).map(sourceInfo);
    return { sources, names: [...new Set(sources.map(source => source.name))] };
  }
  return Object.freeze({ SECURITY_NAME, KIND_STYLES, KIND_RANK, displayKey, subtype, matches, categories, groupFeed,
    sourceInfo, sourceSummary, sentences, paragraphs });
});
