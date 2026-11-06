/* Parallel timeline page (병렬 타임라인 v3).
 * Loads data/parallel/index.json, sessions/<date>.json and notes/<date>.json, validates them with ParallelCore,
 * draws the chart with ParallelChart and renders the analyst notes plus the automatic bullets.
 * Data bases on <owner>.github.io: the index and sessions come from the data branch (parallel-data) on
 * raw.githubusercontent.com, then main there, then the same-origin Pages copy; notes (written on main) come from
 * main first, then the data branch, then the same origin. Elsewhere only the same origin is read. A host that
 * failed with a network error or a timeout is tried last for 10 minutes; a base with another one after it gets
 * 5 s, the last one 15 s.
 * Interaction: date select, theme toggle (saved in localStorage), crosshair and tooltip (pointer, and a keyboard
 * slider for assistive technology), % / 가격 timetable toggle, PNG export. Polling: every 5 minutes while a
 * non-final session is visible (until 24 h after its window end), plus a retry with backoff (30 s, 2 min, 5 min)
 * after any failed request, also for final sessions. Containers are rewritten only when their HTML changes, so a
 * refresh keeps keyboard focus. Never writes data. The HTML builders are pure functions exported as
 * window.ParallelView (module.exports in Node) so tests can call them without a DOM.
 */
(function (root, factory) {
  'use strict';
  const node = typeof module === 'object' && module && module.exports;
  const core = node ? require('./parallel-core.js') : root.ParallelCore;
  const api = factory(core);
  if (node) {
    module.exports = api;
    return;
  }
  root.ParallelView = api;
  const doc = root.document;
  if (!doc) return;
  const boot = () => api.start(root);
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', boot);
  else boot();
})(typeof globalThis !== 'undefined' ? globalThis : this, function (C) {
  'use strict';

  if (!C) {
    // parallel-core.js failed to load: show one clear message instead of an empty page.
    return {
      start(win) {
        const chart = win.document.getElementById('chart');
        if (chart) chart.innerHTML = '<p class="chart-empty">페이지 스크립트를 불러오지 못했습니다. 새로고침해 주세요.</p>';
        const status = win.document.getElementById('status');
        if (status) {
          status.textContent = '수신 실패';
          status.setAttribute('data-state', 'error');
        }
      },
    };
  }

  const MINUTE = 60000;
  const HOUR = 60 * MINUTE;
  const POLL_MS = 5 * MINUTE;
  // Retry delays after a load with any failure (reset by a clean load); live sessions use at most POLL_MS.
  const RETRY_MS = [30000, 2 * MINUTE, 5 * MINUTE];
  const TIMEOUT_MS = 15000; // the last base of a request
  const FAST_TIMEOUT_MS = 5000; // a base with another one after it
  const HOST_DOWN_MS = 10 * MINUTE; // a host that failed with a network error or timeout is tried last this long
  const VISIBLE_RELOAD_GAP_MS = 30000;
  // A non-final session is '갱신 지연' when its file is older than this or its window ended this long ago.
  const LIVE_STALE_MS = 30 * MINUTE;
  const LIVE_LATE_MS = HOUR;
  // Polling of a non-final session stops this long after its window end (the collector gave up on it).
  const POLL_STOP_MS = 24 * HOUR;
  // Without ?date, a newest session still being collected with fewer series or less data than this is not
  // the default view while an older final session exists.
  const SPARSE_SERIES = 10;
  const SPARSE_SPAN_MS = 30 * MINUTE;
  const DATA_BRANCH = 'parallel-data';
  const THEME_KEY = 'parallel-theme';
  const SAME_ORIGIN_BASE = 'data/parallel/';
  const PNG_WIDTH = 1400;
  const PNG_SCALE = 2;
  const NARROW_TIP_BELOW = 560;
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
  const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];
  const DEFAULT_TITLE = '시장 병렬 타임라인';
  const BASIS_TEXT = '지수·종목은 전일 종가 대비, 선물·크립토·환율·금은 08:00 KST 대비';
  const KIND_LABELS = { call: '호출', projection: '투영', statement: '발언', concession: '승복', prediction: '예측', band: '구간', other: '기타' };
  const STATUS_LABELS = { ok: '정상', stale: '이전 자료 유지', missing: '자료 없음', error: '수집 실패' };
  const PROVIDER_SHORT = { yahoo: 'Yahoo', coinmetrics: 'Coin Metrics' };
  const PANEL_SHORT = { indices: '주식지수', ai: 'AI·반도체', crypto: '크립토', fx: '달러·금' };
  // Units of the timetable when it shows values instead of percentages.
  const VALUE_UNITS = { indices: '지수 포인트', ai: '현지 통화 주가', crypto: 'USD 가격', fx: '지수·환율·금 USD' };
  const CIRCLED = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳';
  const FOCUSABLE = 'a[href], button, summary, select, input, textarea, [tabindex]:not([tabindex="-1"])';
  const RANK = new Map(C.SERIES.map((s, i) => [s.id, i]));

  const esc = C.escapeHtml;
  const inline = C.renderInline;

  // ---------------------------------------------------------------- small helpers

  function ymd(date) {
    const m = typeof date === 'string' ? DATE_RE.exec(date) : null;
    if (!m) return null;
    const ms = Date.UTC(+m[1], +m[2] - 1, +m[3]);
    if (new Date(ms).toISOString().slice(0, 10) !== date) return null;
    return { y: +m[1], m: +m[2], d: +m[3], dow: new Date(ms).getUTCDay() };
  }

  /** '11/4(수)' for '2026-11-04'. */
  function shortDate(date) {
    const p = ymd(date);
    return p ? `${p.m}/${p.d}(${WEEKDAYS[p.dow]})` : String(date == null ? '' : date);
  }

  /** '2026년 11월 4일(수)' for '2026-11-04'. */
  function longDate(date) {
    const p = ymd(date);
    return p ? `${p.y}년 ${p.m}월 ${p.d}일(${WEEKDAYS[p.dow]})` : String(date == null ? '' : date);
  }

  /** KST 'HH:MM', prefixed with 'M/D ' when the KST date is not refDate. */
  function clock(ms, refDate) {
    if (!Number.isFinite(ms)) return '';
    const day = C.kstDate(ms);
    const p = ymd(day);
    return `${refDate && day === refDate ? '' : `${p.m}/${p.d} `}${C.kstTime(ms)}`;
  }

  /** 'HH:MM KST' (or 'M/D HH:MM KST') for an ISO time, '' when it does not parse. */
  function kstStamp(iso, refDate) {
    const ms = C.toMs(iso);
    return Number.isFinite(ms) ? `${clock(ms, refDate)} KST` : '';
  }

  const isText = (v) => typeof v === 'string' && v.trim() !== '';
  const textItems = (list) => (Array.isArray(list) ? list.filter(isText) : []);
  const stripMarks = (s) => String(s).replace(/\*\*(.+?)\*\*/g, '$1');

  /** The URL when it is a plain https:// URL, else null (non-https links are shown as text only). */
  function safeUrl(url) {
    if (typeof url !== 'string' || !/^https:\/\/[^\s"'<>`]+$/i.test(url)) return null;
    try {
      return new URL(url).protocol === 'https:' ? url : null;
    } catch (error) {
      return null;
    }
  }

  /** An external link around already-escaped html, or the html alone when the URL is not safe. */
  function link(url, html) {
    const u = safeUrl(url);
    return u ? `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${html}</a>` : html;
  }

  function circled(n) {
    return n >= 1 && n <= CIRCLED.length ? CIRCLED[n - 1] : `(${n})`;
  }

  function seriesList(session) {
    return session && Array.isArray(session.series) ? session.series.filter((s) => s && typeof s === 'object') : [];
  }

  /** Series of one panel in the chart's order (catalog order, unknown ids last), so colors match the lines. */
  function panelSeries(session, key) {
    const rank = (x) => (RANK.has(x.s.id) ? RANK.get(x.s.id) : 1000 + x.i);
    return seriesList(session).map((s, i) => ({ s, i }))
      .filter((x) => x.s.panel === key)
      .sort((a, b) => rank(a) - rank(b))
      .map((x) => x.s);
  }

  /** Series id -> color slot (index within its panel, 0..4) as the chart assigns it. */
  function colorSlots(session) {
    const slots = new Map();
    for (const p of C.PANELS) panelSeries(session, p.key).forEach((s, k) => slots.set(s.id, k % 5));
    return slots;
  }

  const pctDigits = (panelKey) => (panelKey === 'fx' ? 2 : 1);
  const intervalOf = (session) => (session && Number.isInteger(session.intervalMinutes) && session.intervalMinutes > 0 ? session.intervalMinutes : 15);

  /** Time (ms) of the newest point inside win over all series, -Infinity when there is none. */
  function newestTime(session, win) {
    let last = -Infinity;
    for (const s of seriesList(session)) {
      const pts = C.seriesView(s, win);
      if (pts.length) last = Math.max(last, pts[pts.length - 1].t);
    }
    return last;
  }

  /** Time (ms) of the last point of a series in the whole file, NaN when it has none. */
  function lastPointTime(series) {
    const pts = C.seriesView(series, null);
    return pts.length ? pts[pts.length - 1].t : NaN;
  }

  // ---------------------------------------------------------------- data location

  /**
   * Data base URLs in fetch order. On <owner>.github.io the files come from raw.githubusercontent.com first
   * (fresher than the Pages build): index and sessions ('data') from the data branch, then main; notes (written
   * on main) from main, then the data branch. The same-origin copy is always last; elsewhere it is the only one.
   * The repo is the first path segment of a project page, or '<owner>.github.io' for a user page.
   */
  function dataBases(loc, kind) {
    const host = String((loc && loc.hostname) || '').toLowerCase();
    const suffix = '.github.io';
    if (!host.endsWith(suffix) || host.length === suffix.length) return [SAME_ORIGIN_BASE];
    const owner = host.slice(0, -suffix.length);
    const path = String((loc && loc.pathname) || '/');
    const parts = path.split('/').filter(Boolean);
    const dirs = path.endsWith('/') ? parts : parts.slice(0, -1);
    let repo = dirs.length ? dirs[0] : host;
    try {
      repo = decodeURIComponent(repo);
    } catch (error) {
      return [SAME_ORIGIN_BASE];
    }
    if (!/^[a-z0-9-]+$/.test(owner) || !/^[A-Za-z0-9._-]+$/.test(repo) || /^\.+$/.test(repo)) return [SAME_ORIGIN_BASE];
    const raw = (branch) => `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/data/parallel/`;
    const branches = kind === 'notes' ? ['main', DATA_BRANCH] : [DATA_BRANCH, 'main'];
    return branches.map(raw).concat(SAME_ORIGIN_BASE);
  }

  /** Host of an absolute base ('' for the same-origin base). */
  function baseHost(base) {
    const m = /^https?:\/\/([^/?#]+)/i.exec(String(base));
    return m ? m[1].toLowerCase() : '';
  }

  /** True when host failed with a network error or a timeout within HOST_DOWN_MS (down: Map host -> ms). */
  function hostDown(down, host, now) {
    const t = down && typeof down.get === 'function' ? down.get(host) : undefined;
    return Number.isFinite(t) && now - t < HOST_DOWN_MS;
  }

  /** Bases in try order: those on a host that is down (hostDown) go last, otherwise in the given order. */
  function orderBases(bases, down, now) {
    const isDown = (b) => hostDown(down, baseHost(b), now);
    return bases.filter((b) => !isDown(b)).concat(bases.filter(isDown));
  }

  /** Abort time for one base: short while another base remains, longer for the last one. */
  function baseTimeout(isLast) {
    return isLast ? TIMEOUT_MS : FAST_TIMEOUT_MS;
  }

  /** url + '?t=<minute bucket>' so caches are bypassed at most once a minute. */
  function withMinute(url, nowMs) {
    return `${url}${url.indexOf('?') >= 0 ? '&' : '?'}t=${Math.floor(nowMs / MINUTE)}`;
  }

  /** The ?date=YYYY-MM-DD value of a location.search string, or null. */
  function dateParam(search) {
    let value = null;
    try {
      value = new URLSearchParams(String(search || '')).get('date');
    } catch (error) {
      value = null;
    }
    return value && ymd(value) ? value : null;
  }

  // ---------------------------------------------------------------- default date and polling

  /** An index entry of a session still being collected with fewer than SPARSE_SERIES series with data. */
  function thinEntry(entry) {
    return !!entry && entry.final !== true && Number.isInteger(entry.seriesWithData) && entry.seriesWithData < SPARSE_SERIES;
  }

  /** A session still being collected whose window holds fewer than SPARSE_SERIES series with data or under 30 minutes of data. */
  function sparseSession(session, win) {
    if (!session || session.final === true || !session.window) return false;
    const w = win || C.displayWindow(session, null);
    let count = 0;
    let first = Infinity;
    let last = -Infinity;
    for (const s of seriesList(session)) {
      const pts = C.seriesView(s, w);
      if (!pts.length) continue;
      count += 1;
      first = Math.min(first, pts[0].t);
      last = Math.max(last, pts[pts.length - 1].t);
    }
    return count < SPARSE_SERIES || !(last - first >= SPARSE_SPAN_MS);
  }

  /**
   * Default dates from the index: the newest session, the newest final session before it when the newest is not
   * final (shown instead while the newest is sparse), and whether the index already says the newest is thin.
   */
  function defaultDates(index) {
    const list = index && Array.isArray(index.sessions) ? index.sessions.filter((e) => e && ymd(e.date)) : [];
    if (!list.length) return { newest: null, older: null, thin: false };
    const newest = list[0];
    const older = newest.final === true ? null : list.find((e) => e.final === true && e.date < newest.date);
    return { newest: newest.date, older: older ? older.date : null, thin: thinEntry(newest) };
  }

  /** True while a session should be polled: not final and at most POLL_STOP_MS after its window end. */
  function pollsLive(session, now) {
    if (!session || session.final === true) return false;
    const end = C.toMs(session.window && session.window.end);
    return !Number.isFinite(end) || !Number.isFinite(now) || now <= end + POLL_STOP_MS;
  }

  /** Delay before the next load, or null for none: retries after failures, else the live poll. */
  function nextDelay(o) {
    const x = o || {};
    if (x.hidden) return null;
    const live = pollsLive(x.session, x.now);
    if (x.failures > 0) {
      const step = RETRY_MS[Math.min(x.failures, RETRY_MS.length) - 1];
      return live ? Math.min(step, POLL_MS) : step;
    }
    return live ? POLL_MS : null;
  }

  // ---------------------------------------------------------------- header

  /** Stale and failed series of a session (series objects). */
  function seriesProblems(session) {
    const stale = [];
    const failed = [];
    for (const s of seriesList(session)) {
      if (s.status === 'stale') stale.push(s);
      else if (s.status === 'error') failed.push(s);
    }
    return { stale, failed };
  }

  /** '코스피(09:45까지)' for a stale series (its label alone when it has no points). */
  function staleName(series, refDate) {
    const t = lastPointTime(series);
    return Number.isFinite(t) ? `${series.label}(${clock(t, refDate)}까지)` : String(series.label);
  }

  /**
   * Status pill: {state: loading|live|warn|stale|final|error, text}. input: {session, error, now (ms, default the
   * clock)}. A non-final session whose file is over 30 minutes old, or whose window ended over an hour ago, is
   * '갱신 지연 · M/D HH:MM'; stale and failed series add ' · 일부 지연 n' (or ' · 일부 수집 실패 n' when final).
   */
  function statusInfo(input) {
    const o = input || {};
    if (o.error) return { state: 'error', text: o.session ? '수신 실패 · 마지막 정상 자료' : '수신 실패' };
    const s = o.session;
    if (!s) return { state: 'loading', text: '불러오는 중' };
    const now = Number.isFinite(o.now) ? o.now : Date.now();
    const p = seriesProblems(s);
    const n = p.stale.length + p.failed.length;
    if (s.final) return n ? { state: 'warn', text: `최종 · 일부 수집 실패 ${n}` } : { state: 'final', text: '최종' };
    const gen = C.toMs(s.generatedAt);
    const end = C.toMs(s.window && s.window.end);
    const tail = n ? ` · 일부 지연 ${n}` : '';
    if ((Number.isFinite(gen) && now - gen > LIVE_STALE_MS) || (Number.isFinite(end) && now - end > LIVE_LATE_MS)) {
      const when = Number.isFinite(gen) ? clock(gen, null) : '시각 미상';
      return { state: 'stale', text: `갱신 지연 · ${when}${tail}` };
    }
    const text = Number.isFinite(gen) ? `실시간 · ${C.kstTime(gen)} 갱신` : '실시간';
    return n ? { state: 'warn', text: `${text}${tail}` } : { state: 'live', text };
  }

  function statusText(input) {
    return statusInfo(input).text;
  }

  /** Pill tooltip: the failed requests, else the delayed and failed series. */
  function statusTitle(session, error) {
    if (error) return `최근 확인 실패: ${error}`;
    const p = seriesProblems(session);
    const parts = [];
    if (p.stale.length) parts.push(`이전 자료 표시: ${p.stale.map((s) => staleName(s, session.date)).join('·')}`);
    if (p.failed.length) parts.push(`수집 실패: ${p.failed.map((s) => s.label).join('·')}`);
    return parts.join(' · ');
  }

  function titleText(notes) {
    return notes && isText(notes.title) ? stripMarks(notes.title) : DEFAULT_TITLE;
  }

  /** '2026년 11월 4일(수) · 08:00–16:00 KST · 15분봉' (the displayed window). */
  function metaText(session, notes) {
    if (!session || !session.window) return '';
    const win = C.displayWindow(session, notes || null);
    return `${longDate(session.date)} · ${C.kstTime(win.start)}–${C.kstTime(win.end)} KST · ${intervalOf(session)}분봉`;
  }

  /**
   * The chart's subtitle line (what the dashed lines and the band are): notes.subtitle, else the chart default
   * when events are drawn; '' without notes.
   */
  function subtitleText(session, notes) {
    if (!notes) return '';
    if (isText(notes.subtitle)) return stripMarks(notes.subtitle);
    if (!session || !session.window) return '';
    return C.eventsInWindow(notes, C.displayWindow(session, notes)).length ? `세로 점선 = 사건 시각 · ${intervalOf(session)}분봉` : '';
  }

  /**
   * <option>s for the index sessions: '11/4(수) · {title or 분석 노트 없음}'. selectedTitle (the title of the
   * notes loaded for the selected date) wins over the index, which can lag behind newly published notes.
   */
  function dateOptionsHtml(index, selected, selectedTitle) {
    const known = !!(index && Array.isArray(index.sessions));
    const list = known ? index.sessions.filter((s) => s && ymd(s.date)) : [];
    const titleOf = (s) => (s.date === selected && isText(selectedTitle) ? selectedTitle : s.title);
    const options = list.map((s) => ({ date: s.date, label: `${shortDate(s.date)} · ${isText(titleOf(s)) ? stripMarks(titleOf(s)) : '분석 노트 없음'}` }));
    if (ymd(selected) && !options.some((o) => o.date === selected)) {
      // A date from ?date= that the index does not list (or the index failed to load).
      options.unshift({ date: selected, label: known ? `${shortDate(selected)} · 목록에 없는 날짜` : shortDate(selected) });
    }
    return options.map((o) => `<option value="${esc(o.date)}"${o.date === selected ? ' selected' : ''}>${esc(o.label)}</option>`).join('');
  }

  /**
   * The notice line of the default view while the newest session is sparse: '오늘(M/D) 세션 수집 중 · 보기', or for
   * an earlier date (a session that was never completed) 'M/D(요일) 세션 자료 적음 · 보기'.
   */
  function pendingNoticeHtml(date, nowMs) {
    const p = ymd(date);
    if (!p) return '';
    const today = Number.isFinite(nowMs) && C.kstDate(nowMs) === date;
    const text = today ? `오늘(${p.m}/${p.d}) 세션 수집 중` : `${shortDate(date)} 세션 자료 적음`;
    return `${esc(text)} · <a href="?date=${esc(date)}" data-date="${esc(date)}">보기</a>`;
  }

  /** Text of the notice shown when a session has no notes: absent (404) or failed to load or validate. */
  function notesNotice(notesError) {
    return notesError ? `분석 노트를 불러오지 못했습니다(${notesError}). 잠시 후 다시 시도합니다.` : '이 날짜의 분석 노트가 없습니다.';
  }

  /** 'parallel-timeline-20261104.png'; a session still being collected adds its KST generation time (-HHMM). */
  function pngFileName(date, theme, session) {
    const day = ymd(date) ? date.replace(/-/g, '') : 'session';
    const gen = session && session.final !== true ? C.toMs(session.generatedAt) : NaN;
    const time = Number.isFinite(gen) ? `-${C.kstTime(gen).replace(':', '')}` : '';
    return `parallel-timeline-${day}${time}${theme === 'dark' ? '-dark' : ''}.png`;
  }

  // ---------------------------------------------------------------- notes sections

  function headlineHtml(notes) {
    return notes && isText(notes.headline) ? inline(notes.headline) : '';
  }

  function verdictHtml(notes) {
    return notes && isText(notes.verdict) ? inline(notes.verdict) : '';
  }

  /**
   * Analyst observations first, then the automatic bullets, each tagged '자동'. basis (core.insightsBasis: the time
   * basis of the automatic bullets and of the notes) is a muted line in front of the automatic bullets.
   */
  function insightsHtml(notes, auto, basis) {
    const items = textItems(notes && notes.observations).map((t) => `<li>${inline(t)}</li>`);
    const autos = (Array.isArray(auto) ? auto : []).filter((it) => it && isText(it.text))
      .map((it) => `<li class="is-auto"><span class="tag">자동</span>${esc(it.text)}</li>`);
    if (autos.length && isText(basis)) items.push(`<li class="obs-basis">${esc(basis)}</li>`);
    return items.concat(autos).join('');
  }

  /** Analyst sections as cards: <article><h3>heading</h3><ul>items</ul></article>. */
  function sectionsHtml(notes) {
    const list = notes && Array.isArray(notes.sections) ? notes.sections : [];
    return list.filter((s) => s && isText(s.heading)).map((s) => {
      const items = textItems(s.items);
      const id = typeof s.id === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(s.id) ? ` id="note-${s.id}"` : '';
      return `<article class="card note-card"${id}><h3>${inline(s.heading)}</h3>`
        + `${items.length ? `<ul>${items.map((t) => `<li>${inline(t)}</li>`).join('')}</ul>` : ''}</article>`;
    }).join('');
  }

  function watchHtml(notes) {
    return textItems(notes && notes.watch).map((t) => `<li>${inline(t)}</li>`).join('');
  }

  /** Story paragraphs, each followed by '출처: label · label' (linked when the source has an https URL). */
  function storyHtml(notes) {
    const list = notes && Array.isArray(notes.story) ? notes.story : [];
    return list.filter((p) => p && isText(p.text)).map((p) => {
      const sources = (Array.isArray(p.sources) ? p.sources : []).filter((s) => s && isText(s.label));
      const src = sources.length ? `<p class="src">출처: ${sources.map((s) => link(s.url, esc(s.label))).join(' · ')}</p>` : '';
      return `<div class="para"><p>${inline(p.text)}</p>${src}</div>`;
    }).join('');
  }


  // ---------------------------------------------------------------- story timeline (시안 B′)

  const STL_PARTS = ['asia', 'crypto', 'us'];
  const STL_PART_LABELS = { asia: '아시아 증시', crypto: '크립토', us: '미국 증시' };
  const STL_LINK_KINDS = ['cause', 'none', 'contrast'];
  const STL_PPM = 0.6; // px per minute
  const STL_FOLD_MIN_MS = 6 * HOUR; // a quiet stretch longer than this is folded
  const STL_FOLD_PX = 84;
  const STL_BAND_PX = 32; // vertical room reserved for a checkpoint band
  const STL_MIN_WIDTH = 900; // narrower containers fall back to the paragraph list
  const stlId = (v) => (typeof v === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(v) ? v : null);

  /**
   * Timeline model from analyst notes, or null when the story is not tagged for it. A story paragraph takes part in
   * the timeline when it has part (asia | crypto | us) and a parseable at. Optional: id, end, links [{to, kind, note}]
   * (kind: cause | none | contrast; a link whose target id is unknown is dropped). notes.bands: [{at, label, text,
   * rails: {left: [..], right: [..]}}] are the checkpoint captions; notes.rails: {left, right} name the two mediator
   * rails between the columns (shown only when some band carries rail values).
   */
  function storyTimelineModel(notes) {
    const list = notes && Array.isArray(notes.story) ? notes.story : [];
    const cards = [];
    list.forEach((p, i) => {
      if (!p || !isText(p.text) || !STL_PARTS.includes(p.part)) return;
      const at = C.toMs(p.at);
      if (!Number.isFinite(at)) return;
      const end = C.toMs(p.end);
      cards.push({ id: stlId(p.id) || `stl-${i}`, part: p.part, at, end: Number.isFinite(end) && end > at ? end : null,
        text: p.text, sources: (Array.isArray(p.sources) ? p.sources : []).filter((x) => x && isText(x.label)),
        links: (Array.isArray(p.links) ? p.links : []).filter((l) => l && stlId(l.to) && STL_LINK_KINDS.includes(l.kind))
          .map((l) => ({ to: l.to, kind: l.kind, note: isText(l.note) ? l.note : '' })) });
    });
    if (!cards.length) return null;
    const ids = new Set(cards.map((c) => c.id));
    const links = [];
    for (const c of cards) for (const l of c.links) if (ids.has(l.to) && l.to !== c.id) links.push({ from: c.id, to: l.to, kind: l.kind, note: l.note });
    const bands = (notes && Array.isArray(notes.bands) ? notes.bands : []).map((b) => {
      const at = b ? C.toMs(b.at) : NaN;
      if (!Number.isFinite(at)) return null;
      const rails = b.rails && typeof b.rails === 'object' ? b.rails : {};
      return { at, label: isText(b.label) ? b.label : C.kstTime(at), text: isText(b.text) ? b.text : '',
        left: textItems(rails.left), right: textItems(rails.right) };
    }).filter(Boolean).sort((a, b) => a.at - b.at);
    const hasRails = bands.some((b) => b.left.length || b.right.length);
    const names = notes && notes.rails && typeof notes.rails === 'object' ? notes.rails : {};
    return { cards: cards.slice().sort((a, b) => a.at - b.at), links, bands,
      rails: hasRails ? { left: isText(names.left) ? names.left : '', right: isText(names.right) ? names.right : '' } : null };
  }

  /**
   * Vertical scale of the timeline: y(t) in px for an instant, with quiet stretches longer than STL_FOLD_MIN_MS folded to
   * STL_FOLD_PX and STL_BAND_PX reserved under every band time. Returns {y, yBand, folds: [{from, to}], top, end}.
   */
  function timelineScale(times, bandTimes) {
    const pts = Array.from(new Set(times.concat(bandTimes).filter(Number.isFinite))).sort((a, b) => a - b);
    if (!pts.length) return null;
    const t0 = pts[0];
    const folds = [];
    for (let i = 1; i < pts.length; i++) {
      if (pts[i] - pts[i - 1] > STL_FOLD_MIN_MS) folds.push({ from: pts[i - 1] + 20 * MINUTE, to: pts[i] - 10 * MINUTE });
    }
    const raw = (t) => {
      let y = ((t - t0) / MINUTE) * STL_PPM;
      for (const f of folds) {
        const span = ((f.to - f.from) / MINUTE) * STL_PPM;
        if (t >= f.to) y -= span - STL_FOLD_PX;
        else if (t > f.from) y -= ((t - f.from) / MINUTE) * STL_PPM - STL_FOLD_PX * ((t - f.from) / (f.to - f.from));
      }
      return y;
    };
    const sortedBands = bandTimes.filter(Number.isFinite).slice().sort((a, b) => a - b);
    const y = (t) => sortedBands.reduce((v, b) => (t >= b ? v + STL_BAND_PX : v), raw(t));
    const yBand = (b) => sortedBands.reduce((v, x) => (b > x ? v + STL_BAND_PX : v), raw(b));
    return { y, yBand, folds, top: t0, end: pts[pts.length - 1] };
  }

  /** Static skeleton of the timeline; positions are applied by layoutStoryTimeline in the browser. */
  function storyTimelineHtml(notes, refDate) {
    const m = storyTimelineModel(notes);
    if (!m) return '';
    const cols = m.rails ? ['axis', 'asia', 'rail-left', 'crypto', 'rail-right', 'us'] : ['axis', 'asia', 'crypto', 'us'];
    const head = cols.map((c) => {
      if (c === 'axis') return '<div class="stl-corner" aria-hidden="true"></div>';
      if (c.startsWith('rail')) return `<div class="stl-railhd">${esc(c === 'rail-left' ? m.rails.left : m.rails.right)}</div>`;
      return `<h3 class="stl-colhd stl-${c}">${esc(STL_PART_LABELS[c])}</h3>`;
    }).join('');
    const body = cols.map((c) => {
      if (c === 'axis') return '<div class="stl-axis" data-col="axis"></div>';
      if (c.startsWith('rail')) {
        const side = c === 'rail-left' ? 'left' : 'right';
        const chips = m.bands.map((b) => (b[side].length ? `<div class="stl-rchip" data-at="${b.at}">${b[side].map((v) => `<span>${esc(v)}</span>`).join('')}</div>` : '')).join('');
        return `<div class="stl-rail" data-col="${c}">${chips}</div>`;
      }
      const cards = m.cards.filter((k) => k.part === c).map((k) => {
        const when = k.end ? `${clock(k.at, refDate)}–${clock(k.end, refDate)}` : clock(k.at, refDate);
        const src = k.sources.length ? `<p class="src">출처: ${k.sources.map((x) => link(x.url, esc(x.label))).join(' · ')}</p>` : '';
        return `<article class="stl-card" id="stl-${esc(k.id)}" data-at="${k.at}"><p><span class="stl-t">${esc(when)}</span>${inline(k.text)}</p>${src}</article>`;
      }).join('');
      return `<div class="stl-col stl-${c}" data-col="${c}">${cards || '<p class="stl-none">·</p>'}</div>`;
    }).join('');
    const bands = m.bands.map((b) => `<div class="stl-band" data-at="${b.at}"><b>${esc(b.label)}</b>${b.text ? `<span>${inline(b.text)}</span>` : ''}</div>`).join('');
    const links = m.links.map((l) => `<span class="stl-link" data-from="${esc(l.from)}" data-to="${esc(l.to)}" data-kind="${esc(l.kind)}" data-note="${esc(l.note)}" hidden></span>`).join('');
    const legend = '<p class="stl-legend">세로 = 시각(6시간 넘는 빈 구간은 접음) · 가로 = 시장 · 띠 = 체크포인트 종합'
      + (m.links.length ? ' · 실선 → 전염, 점선 ⇢✕ 무반응, 회색 ↔ 대조' : '') + '</p>';
    return `<div class="stl" data-cols="${cols.length}" data-rails="${m.rails ? '1' : '0'}"><div class="stl-head">${head}</div>`
      + `<div class="stl-body">${body}${bands}${links}</div>${legend}</div>`;
  }

  /**
   * Position the skeleton rendered by storyTimelineHtml: cards at their time (pushed down when they would overlap the
   * previous card, lifted a little when they would run into a band), bands and rail chips at their time, folds on the
   * axis, then the link arrows as one SVG overlay. Safe to call again after a resize.
   */
  function layoutStoryTimeline(box, win) {
    const root = box && box.querySelector ? box.querySelector('.stl') : null;
    if (!root) return false;
    const body = root.querySelector('.stl-body');
    const cards = Array.from(body.querySelectorAll('.stl-card'));
    const bands = Array.from(body.querySelectorAll('.stl-band'));
    const bandTimes = bands.map((b) => Number(b.getAttribute('data-at')));
    const scale = timelineScale(cards.map((c) => Number(c.getAttribute('data-at'))), bandTimes);
    if (!scale) return false;
    const BAND = STL_BAND_PX;
    const heightOf = (n) => n.getBoundingClientRect().height;
    // Cards and bands in time order (a band before a card at the same instant). A card sits at its time, under the
    // previous card of its column and under the last band; a band sits at its time or under every earlier card, and
    // everything after it moves down by the same amount, so time order is kept and nothing overlaps.
    const events = cards.map((n) => ({ kind: 'card', t: Number(n.getAttribute('data-at')), n }))
      .concat(bands.map((n) => ({ kind: 'band', t: Number(n.getAttribute('data-at')), n })))
      .sort((a, b) => a.t - b.t || (a.kind === 'band' ? -1 : 1));
    const lastOf = new Map();
    const bandPos = []; // [{t, y}] final band positions, for rail chips and the axis offset
    let offset = 0;
    let floor = 0;
    let maxBottom = 0;
    let bottom = 0;
    for (const e of events) {
      if (e.kind === 'band') {
        const by = Math.max(scale.yBand(e.t) + offset, maxBottom + 6);
        offset = by - scale.yBand(e.t);
        e.n.style.top = `${by}px`;
        floor = by + BAND + 4;
        bandPos.push({ t: e.t, y: by });
        bottom = Math.max(bottom, by + BAND);
        continue;
      }
      const col = e.n.parentElement;
      const last = lastOf.has(col) ? lastOf.get(col) : -Infinity;
      const top = Math.max(scale.y(e.t) + offset - 4, last + 8, floor);
      const h = heightOf(e.n);
      e.n.style.top = `${top}px`;
      lastOf.set(col, top + h);
      maxBottom = Math.max(maxBottom, top + h);
      bottom = Math.max(bottom, top + h);
    }
    const offsetAt = (t) => {
      let v = 0;
      for (const b of bandPos) if (t >= b.t) v = b.y - scale.yBand(b.t);
      return v;
    };
    for (const chip of body.querySelectorAll('.stl-rchip')) {
      const t = Number(chip.getAttribute('data-at'));
      const b = bandPos.find((x) => x.t === t);
      chip.style.top = `${(b ? b.y + BAND - 4 : scale.y(t) + offsetAt(t) + 2)}px`;
    }
    const axis = body.querySelector('.stl-axis');
    if (axis) {
      const ticks = [];
      const dayStart = Date.parse(C.kstToUtcIso(C.kstDate(scale.top), '00:00'));
      for (let t = dayStart; t <= scale.end + HOUR; t += 3 * HOUR) {
        if (t < scale.top - 30 * MINUTE || t > scale.end + 30 * MINUTE) continue;
        if (scale.folds.some((f) => t > f.from && t < f.to)) continue;
        ticks.push(`<div class="stl-tick" style="top:${scale.y(t) + offsetAt(t)}px"><span>${esc(C.kstTime(t))}</span></div>`);
      }
      const folds = scale.folds.map((f) => `<div class="stl-fold" style="top:${scale.y(f.from) + offsetAt(f.from)}px;height:${STL_FOLD_PX}px" title="${esc(C.kstTime(f.from))}–${esc(C.kstTime(f.to))} 접힘">≈</div>`);
      axis.innerHTML = ticks.join('') + folds.join('');
    }
    body.style.height = `${Math.ceil(bottom + 16)}px`;
    // links
    const old = body.querySelector('svg.stl-links');
    if (old) old.remove();
    const specs = Array.from(body.querySelectorAll('.stl-link'));
    if (specs.length && win && win.document) {
      const d = win.document;
      const svg = d.createElementNS(SVG_NS, 'svg');
      svg.setAttribute('class', 'stl-links');
      svg.setAttribute('aria-hidden', 'true');
      svg.innerHTML = '<defs><marker id="stl-ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto">'
        + '<path d="M0,0 L10,5 L0,10 z" class="stl-ar"/></marker><marker id="stl-x" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="9" markerHeight="9" orient="auto">'
        + '<path d="M2,2 L8,8 M8,2 L2,8" class="stl-x"/></marker></defs>';
      const br = body.getBoundingClientRect();
      const zoom = br.width > 0 && body.offsetWidth > 0 ? br.width / body.offsetWidth : 1;
      for (const spec of specs) {
        const A = body.querySelector(`#stl-${CSS.escape(spec.getAttribute('data-from'))}`);
        const B = body.querySelector(`#stl-${CSS.escape(spec.getAttribute('data-to'))}`);
        if (!A || !B) continue;
        const a = A.getBoundingClientRect();
        const b = B.getBoundingClientRect();
        const leftToRight = a.left < b.left;
        const ax = ((leftToRight ? a.right : a.left) - br.left) / zoom;
        const bx = ((leftToRight ? b.left : b.right) - br.left) / zoom;
        const ay = (a.top - br.top) / zoom + Math.min(26, a.height / zoom / 2);
        const by = (b.top - br.top) / zoom + Math.min(26, b.height / zoom / 2);
        const mx = (ax + bx) / 2;
        const kind = spec.getAttribute('data-kind');
        const path = d.createElementNS(SVG_NS, 'path');
        path.setAttribute('d', `M${ax},${ay} C${mx},${ay} ${mx},${by} ${bx},${by}`);
        path.setAttribute('class', `stl-path stl-${kind}`);
        path.setAttribute('marker-end', kind === 'none' ? 'url(#stl-x)' : kind === 'cause' ? 'url(#stl-ar)' : '');
        svg.appendChild(path);
        const note = spec.getAttribute('data-note');
        if (note) {
          const g = d.createElementNS(SVG_NS, 'g');
          const rect = d.createElementNS(SVG_NS, 'rect');
          const text = d.createElementNS(SVG_NS, 'text');
          text.setAttribute('x', ax + (bx - ax) * 0.4);
          text.setAttribute('y', (ay + by) / 2 - 8);
          text.setAttribute('text-anchor', 'middle');
          text.setAttribute('class', 'stl-lbl');
          text.textContent = note;
          g.appendChild(rect);
          g.appendChild(text);
          svg.appendChild(g);
          const tb = text.getBBox();
          rect.setAttribute('x', tb.x - 6);
          rect.setAttribute('y', tb.y - 3);
          rect.setAttribute('width', tb.width + 12);
          rect.setAttribute('height', tb.height + 6);
          rect.setAttribute('rx', 4);
          rect.setAttribute('class', 'stl-lblbg');
        }
      }
      body.appendChild(svg);
    }
    return true;
  }

  /** Event list: KST time (band: range), chart number, label + sub, kind, source and alternative times. */
  function eventsHtml(notes, win) {
    const all = C.eventsInWindow(notes || null, null);
    const shown = win ? C.eventsInWindow(notes || null, win) : all;
    const ref = notes && ymd(notes.date) ? notes.date : null;
    return all.map((e) => {
      const at = C.toMs(e.at);
      const end = e.end == null ? NaN : C.toMs(e.end);
      const band = Number.isFinite(end) && end > at;
      const when = band ? `${clock(at, ref)}–${clock(end, ref)}` : clock(at, ref);
      const n = shown.indexOf(e);
      const num = n >= 0 ? `<span class="ev-num" title="차트 표시 번호">${circled(n + 1)}</span>` : '';
      const sub = isText(e.sub) ? `<span class="ev-sub">${inline(e.sub)}</span>` : '';
      const kind = KIND_LABELS[e.kind] ? `<span class="badge">${KIND_LABELS[e.kind]}</span>` : '';
      const detail = isText(e.detail) ? `<p class="ev-detail">${inline(e.detail)}</p>` : '';
      const src = [];
      if (isText(e.source)) src.push(link(e.url, esc(e.source)));
      else if (safeUrl(e.url)) src.push(link(e.url, '원문'));
      const alts = (Array.isArray(e.alts) ? e.alts : []).filter((a) => a && isText(a.source)).map((a) => {
        const t = C.toMs(a.at);
        return link(a.url, esc(Number.isFinite(t) ? `${a.source} ${clock(t, ref)}` : a.source));
      });
      if (alts.length) src.push(`다른 시각: ${alts.join(' · ')}`);
      return `<li><time datetime="${esc(e.at)}">${esc(when)}</time><div class="ev-body">`
        + `<p class="ev-head">${num}<strong>${inline(e.label)}</strong>${sub}${kind}</p>${detail}`
        + `${src.length ? `<p class="ev-src">${src.join(' · ')}</p>` : ''}</div></li>`;
    }).join('');
  }

  // ---------------------------------------------------------------- timetable

  /** One cell: the percentage (or the value when prices is set); the other number and an earlier time go in the title. */
  function cellHtml(cell, row, digits, prices) {
    if (!cell) return '<td class="na"><span aria-hidden="true">·</span><span class="sr-only">자료 없음</span></td>';
    const pct = C.formatPct(cell.p, digits);
    const value = C.formatValue(cell.v);
    const shown = esc(prices ? value : pct);
    const other = prices ? pct : value;
    if (row.kind === 'hour') {
      const title = Number.isFinite(cell.t) && cell.t !== row.t ? `${C.kstTime(cell.t)} KST · ${other}` : other;
      return `<td title="${esc(title)}">${shown}</td>`;
    }
    const at = Number.isFinite(cell.t) ? C.kstTime(cell.t) : '';
    const title = at ? `${at} KST · ${other}` : other;
    return `<td title="${esc(title)}">${row.kind === 'min' ? `<strong>${shown}</strong>` : shown}${at ? `<span class="at">${at}</span>` : ''}</td>`;
  }

  /**
   * Hour-by-hour table of one panel (core.hourlyTable): hour rows, then the emphasized low row and the last row.
   * opts.prices shows values instead of percentages. While a session is being collected, hours after its newest
   * data are left out (they have not happened yet; a '·' cell is a real gap).
   */
  function timetableHtml(session, panelKey, win, opts) {
    if (!session) return '';
    const prices = !!(opts && opts.prices);
    const w = win || C.displayWindow(session, null);
    const table = C.hourlyTable(session, panelKey, w);
    if (!table.columns.length) return '<p class="empty">이 패널에 표시할 계열이 없습니다.</p>';
    const live = session.final !== true;
    const until = live ? newestTime(session, w) : Infinity;
    const rows = table.rows.filter((row) => row.kind !== 'hour' || row.t <= until);
    const panel = C.PANELS.find((p) => p.key === panelKey);
    const slots = colorSlots(session);
    const byId = new Map(seriesList(session).map((s) => [s.id, s]));
    const digits = pctDigits(panelKey);
    const head = table.columns.map((col) => {
      const s = byId.get(col.id);
      const base = s && s.baseline && s.baseline.value != null
        ? ` title="${esc(`기준: ${s.baseline.label || ''} ${C.formatValue(s.baseline.value)}`.trim())}"` : '';
      // A stale series (provider failed, older points kept) or a failed one says so under its name, as in the chart.
      const last = s && s.status === 'stale' ? lastPointTime(s) : NaN;
      let note = '';
      if (s && s.status === 'error') note = '수집 실패';
      else if (s && s.status === 'stale') note = Number.isFinite(last) ? `${clock(last, session.date)}까지` : '수집 지연';
      return `<th scope="col"${base}><span class="sw c${slots.has(col.id) ? slots.get(col.id) : 0}" aria-hidden="true"></span>${esc(col.label)}`
        + `${note ? `<span class="th-note">${esc(note)}</span>` : ''}</th>`;
    }).join('');
    const body = rows.map((row) => {
      const cls = row.kind === 'min' ? ' class="row-min"' : row.kind === 'last' ? ' class="row-last"' : '';
      return `<tr${cls}><th scope="row" class="t-row">${esc(row.label)}</th>${row.cells.map((cell) => cellHtml(cell, row, digits, prices)).join('')}</tr>`;
    }).join('');
    const name = panel ? `${panel.label} ${prices ? `값(${VALUE_UNITS[panelKey] || '원래 단위'})` : panel.suffix}` : '';
    const upto = live && Number.isFinite(until) ? ` · ${C.kstTime(until)}까지` : '';
    const caption = `${name ? `${name} ` : ''}시간표${upto}`;
    return `<table class="tt"><caption class="sr-only">${esc(caption)}</caption>`
      + `<thead><tr><th scope="col" class="t-row">시각</th>${head}</tr></thead><tbody>${body}</tbody></table>`;
  }

  /** The line above the timetable: what the numbers are, and how far a session being collected goes. */
  function tableBasisText(session, panelKey, win, prices) {
    const panel = C.PANELS.find((p) => p.key === panelKey);
    if (!panel) return '';
    const parts = [prices ? `${panel.label} 값(${VALUE_UNITS[panelKey] || '원래 단위'})` : `${panel.label} ${panel.suffix}`];
    if (session && session.final !== true && session.window) {
      const t = newestTime(session, win || C.displayWindow(session, null));
      if (Number.isFinite(t)) parts.push(`${C.kstTime(t)}까지`);
    }
    return parts.join(' · ');
  }

  // ---------------------------------------------------------------- caption and footer

  function providerList(session) {
    const list = session && Array.isArray(session.providers) && session.providers.length ? session.providers : C.PROVIDERS;
    return list.filter((p) => p && isText(p.label));
  }

  /** Provider names actually used by series with points (all listed providers when none is referenced). */
  function providerNames(session) {
    const used = new Set(seriesList(session)
      .filter((s) => Array.isArray(s.points) && s.points.length && s.source && s.source.provider)
      .map((s) => s.source.provider));
    return providerList(session)
      .filter((p) => !used.size || used.has(p.id))
      .map((p) => `${p.label}${isText(p.license) ? ` (${p.license})` : ''}`)
      .join(', ');
  }

  /** Baselines that differ from the common one, e.g. '11/2 종가 기준: 니케이225·소프트뱅크'. */
  function baselineNotes(session) {
    const prev = new Map();
    const first = new Map();
    for (const s of seriesList(session)) {
      const b = s.baseline;
      if (!b || b.value == null || !isText(b.label)) continue;
      if (s.basis === 'prevClose') prev.set(b.label, (prev.get(b.label) || []).concat(s.label));
      else if (/^첫 관측/.test(b.label)) first.set(b.label, (first.get(b.label) || []).concat(s.label));
    }
    const out = [];
    if (prev.size > 1) {
      let common = null;
      for (const [label, names] of prev) if (common === null || names.length > prev.get(common).length) common = label;
      for (const [label, names] of prev) if (label !== common) out.push(`${label} 기준: ${names.join('·')}`);
    }
    for (const [label, names] of first) out.push(`${label} 기준: ${names.join('·')}`);
    return out;
  }

  /** '최근 수집 실패로 이전 자료 표시: 코스피(09:45까지) · 수집 실패: 항셍' ('' when every series is current). */
  function seriesIssues(session) {
    const p = seriesProblems(session);
    const parts = [];
    if (p.stale.length) parts.push(`최근 수집 실패로 이전 자료 표시: ${p.stale.map((s) => staleName(s, session.date)).join('·')}`);
    if (p.failed.length) parts.push(`수집 실패: ${p.failed.map((s) => s.label).join('·')}`);
    return parts.join(' · ');
  }

  /** Chart caption: basis, baseline exceptions, sources, collection problems and the generation time. */
  function captionText(session) {
    if (!session) return '';
    const parts = [BASIS_TEXT].concat(baselineNotes(session));
    const names = providerNames(session);
    if (names) parts.push(`출처: ${names}`);
    const issues = seriesIssues(session);
    if (issues) parts.push(issues);
    const generated = kstStamp(session.generatedAt, session.date);
    if (generated) parts.push(`자료 생성 ${generated}`);
    return parts.join(' · ');
  }

  /** Footer of the exported PNG: the notes author (as in the reference image), then the page caption. */
  function pngFooter(session, notes) {
    const author = notes && isText(notes.author) ? stripMarks(notes.author) : '';
    return [author, captionText(session)].filter(Boolean).join(' · ');
  }

  function seriesTableHtml(session) {
    const rows = C.PANELS.reduce((acc, p) => acc.concat(panelSeries(session, p.key)), []).map((s) => {
      const b = s.baseline || {};
      const base = `${esc(b.label || '')}${b.value != null ? ` <span class="mono">${esc(C.formatValue(b.value))}</span>` : ''}`;
      const status = `${esc(STATUS_LABELS[s.status] || s.status || '')}${isText(s.note) ? ` · ${esc(s.note)}` : ''}`;
      const src = s.source ? `${esc(PROVIDER_SHORT[s.source.provider] || s.source.provider || '')} <span class="mono">${esc(s.source.symbol || '')}</span>` : '';
      return `<tr><th scope="row">${esc(s.label)}</th><td>${base}</td><td>${status}</td><td>${src}</td></tr>`;
    }).join('');
    if (!rows) return '';
    return '<details class="series-details"><summary>계열별 기준과 상태</summary><div class="table-wrap"><table class="st">'
      + '<thead><tr><th scope="col">계열</th><th scope="col">기준</th><th scope="col">상태</th><th scope="col">원자료</th></tr></thead>'
      + `<tbody>${rows}</tbody></table></div></details>`;
  }

  /** Footer: providers (with the license link), basis, notes author and time, footnote, collector cadence, series table. */
  function footerHtml(session, notes) {
    const providers = providerList(session).map((p) => {
      const extra = [];
      if (isText(p.note)) extra.push(esc(p.note));
      if (isText(p.license)) extra.push(link(p.licenseUrl, esc(p.license)));
      return `${link(p.url, esc(p.label))}${extra.length ? ` (${extra.join(' · ')})` : ''}`;
    });
    const lines = [
      `<p>시세 출처: ${providers.join(' · ')}</p>`,
      `<p>${esc(BASIS_TEXT)} 등락률(%)입니다. 값은 주장이 아닌 시세입니다.</p>`,
    ];
    if (notes) {
      const who = [];
      if (isText(notes.author)) who.push(`작성 ${esc(notes.author)}`);
      const asOf = kstStamp(notes.asOf, notes.date);
      if (asOf) who.push(`${esc(asOf)} 기준`);
      if (who.length) lines.push(`<p>분석 노트: ${who.join(' · ')}</p>`);
      if (isText(notes.footnote)) lines.push(`<p>${inline(notes.footnote)}</p>`);
    }
    lines.push('<p>수집기는 평일 GitHub Actions에서 약 15분마다 실행됩니다.</p>');
    if (session) lines.push(seriesTableHtml(session));
    return lines.join('');
  }

  // ---------------------------------------------------------------- crosshair geometry

  /** Plot x-range. The chart gives layout.right as the plot's right edge; a margin-sized value is read as a margin. */
  function plotBounds(layout) {
    const width = Number(layout && layout.width) || 0;
    const x0 = Number(layout && layout.left) || 0;
    const right = Number(layout && layout.right) || 0;
    const x1 = right > width / 2 ? right : width - right;
    return { x0, x1: Math.max(x0 + 1, x1) };
  }

  function timeToX(layout, t) {
    const b = plotBounds(layout);
    const span = layout.end - layout.start;
    return b.x0 + (span > 0 ? ((t - layout.start) / span) * (b.x1 - b.x0) : 0);
  }

  function xToTime(layout, x) {
    const b = plotBounds(layout);
    const f = Math.min(Math.max((x - b.x0) / (b.x1 - b.x0), 0), 1);
    return layout.start + f * (layout.end - layout.start);
  }

  /** Nearest grid time (session interval, anchored at the session window start) inside win. */
  function snapTime(session, win, t) {
    const w = win || C.displayWindow(session, null);
    const step = intervalOf(session) * MINUTE;
    const anchor = C.toMs(session.window.start);
    let s = anchor + Math.round((t - anchor) / step) * step;
    if (s < w.start) s = anchor + Math.ceil((w.start - anchor) / step) * step;
    if (s > w.end) s = anchor + Math.floor((w.end - anchor) / step) * step;
    return Math.min(Math.max(s, w.start), w.end);
  }

  /** Default keyboard cursor: the grid time at or before the newest point in the window (window end without data). */
  function latestTime(session, win) {
    const w = win || C.displayWindow(session, null);
    const last = newestTime(session, w);
    if (!Number.isFinite(last)) return snapTime(session, w, w.end);
    const step = intervalOf(session) * MINUTE;
    const anchor = C.toMs(session.window.start);
    return snapTime(session, w, anchor + Math.floor((last - anchor) / step) * step);
  }

  /**
   * ARIA values of the chart's time slider: minutes from the display window start (0..window length) and a short
   * value text, e.g. {min: 0, max: 480, now: 255, text: '12:15 KST'}.
   */
  function sliderValues(win, t) {
    const max = Math.max(0, Math.round((win.end - win.start) / MINUTE));
    const at = Number.isFinite(t) ? Math.min(Math.max(t, win.start), win.end) : win.end;
    return { min: 0, max, now: Math.round((at - win.start) / MINUTE), text: `${C.kstTime(at)} KST` };
  }

  /** Crosshair geometry in SVG units: x, one vertical segment per panel and a dot per series with a value at t. */
  function cursorMarks(layout, session, t) {
    const x = timeToX(layout, t);
    const byId = new Map(seriesList(session).map((s) => [s.id, s]));
    const lines = [];
    const dots = [];
    for (const p of layout && Array.isArray(layout.panels) ? layout.panels : []) {
      lines.push({ y1: p.top, y2: p.bottom });
      if (p.empty || !Number.isFinite(p.yMin) || !Number.isFinite(p.yMax) || p.yMax === p.yMin) continue;
      for (const ref of Array.isArray(p.series) ? p.series : []) {
        const q = C.valueAt(byId.get(ref.id), t);
        if (!q) continue;
        const cy = p.bottom - ((q.p - p.yMin) / (p.yMax - p.yMin)) * (p.bottom - p.top);
        dots.push({ cx: timeToX(layout, q.t), cy, color: ref.color });
      }
    }
    return { x, lines, dots };
  }

  /** Tooltip body: the KST time and every series value at t (core.valueAt), grouped by panel. */
  function tooltipHtml(session, t) {
    const slots = colorSlots(session);
    const groups = C.PANELS.map((panel) => {
      const list = panelSeries(session, panel.key);
      if (!list.length) return '';
      const digits = pctDigits(panel.key);
      const rows = list.map((s) => {
        const sw = `<span class="sw c${slots.get(s.id) || 0}" aria-hidden="true"></span>`;
        const q = C.valueAt(s, t);
        if (!q) return `<li class="na">${sw}<span class="lbl">${esc(s.label)}</span><span class="pct">–</span><span class="val"></span></li>`;
        const at = q.t !== t ? ` <span class="at">${C.kstTime(q.t)}</span>` : '';
        return `<li>${sw}<span class="lbl">${esc(s.label)}${at}</span><span class="pct">${esc(C.formatPct(q.p, digits))}</span>`
          + `<span class="val">${esc(C.formatValue(q.v))}</span></li>`;
      }).join('');
      return `<div class="tip-group"><p class="tip-panel">${esc(PANEL_SHORT[panel.key] || panel.label)}</p><ul>${rows}</ul></div>`;
    }).join('');
    return `<p class="tip-time"><strong>${C.kstTime(t)}</strong> KST</p><div class="tip-grid">${groups}</div>`;
  }

  /** Plain-text version of the tooltip for the screen reader live region. */
  function readoutText(session, t) {
    const parts = C.PANELS.map((panel) => {
      const list = panelSeries(session, panel.key);
      if (!list.length) return '';
      const digits = pctDigits(panel.key);
      return `${PANEL_SHORT[panel.key] || panel.label}: ${list.map((s) => {
        const q = C.valueAt(s, t);
        return `${s.label} ${q ? C.formatPct(q.p, digits) : '자료 없음'}`;
      }).join(', ')}`;
    }).filter(Boolean);
    return `${C.kstTime(t)} KST. ${parts.join('. ')}.`;
  }

  // ---------------------------------------------------------------- PNG

  function svgSize(svg, layout) {
    const read = (name) => {
      const m = new RegExp(`<svg[^>]*\\s${name}="([0-9.]+)"`).exec(svg);
      return m ? Number(m[1]) : NaN;
    };
    const width = layout && Number.isFinite(layout.width) ? layout.width : read('width');
    const height = layout && Number.isFinite(layout.height) ? layout.height : read('height');
    return { width, height };
  }

  /** SVG string -> Image -> canvas at the given scale -> PNG Blob. */
  function rasterize(win, svg, layout, scale) {
    return new Promise((resolve, reject) => {
      const size = svgSize(svg, layout);
      if (!(size.width > 0 && size.height > 0)) {
        reject(new Error('차트 크기를 알 수 없습니다'));
        return;
      }
      const img = new win.Image();
      img.onload = () => {
        try {
          const canvas = win.document.createElement('canvas');
          canvas.width = Math.round(size.width * scale);
          canvas.height = Math.round(size.height * scale);
          canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
          if (typeof canvas.toBlob === 'function') {
            canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('PNG 변환 실패'))), 'image/png');
          } else {
            win.fetch(canvas.toDataURL('image/png')).then((r) => r.blob()).then(resolve, reject);
          }
        } catch (error) {
          reject(error);
        }
      };
      img.onerror = () => reject(new Error('SVG 이미지 변환 실패'));
      img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    });
  }

  function saveBlob(win, blob, name) {
    const url = win.URL.createObjectURL(blob);
    const a = win.document.createElement('a');
    a.href = url;
    a.download = name;
    a.rel = 'noopener';
    win.document.body.appendChild(a);
    a.click();
    a.remove();
    win.setTimeout(() => win.URL.revokeObjectURL(url), 5000);
  }

  // ---------------------------------------------------------------- page wiring (browser only)

  function start(win) {
    const doc = win.document;
    const $ = (id) => doc.getElementById(id);
    const el = {
      title: $('title'), meta: $('meta'), subtitle: $('subtitle'), select: $('date-select'), status: $('status'),
      theme: $('theme-toggle'), pngLight: $('png-light'), pngDark: $('png-dark'), note: $('tool-note'),
      pending: $('pending'), noNotes: $('no-notes'), headlineSec: $('headline-sec'), headline: $('headline'),
      box: $('chart-box'), chart: $('chart'), slider: $('chart-slider'), tip: $('tip'), caption: $('chart-caption'),
      help: $('chart-help'), live: $('chart-live'), duo: $('duo'), obs: $('obs'), seg: $('panel-seg'),
      unit: $('unit-seg'), basis: $('table-basis'), table: $('table'), sectionsSec: $('sections-sec'),
      sections: $('sections'), watchSec: $('watch-sec'), watch: $('watch'), storySec: $('story-sec'), story: $('story'),
      verdictSec: $('verdict-sec'), verdict: $('verdict'), eventsSec: $('events-sec'), events: $('events'), foot: $('foot'),
    };
    if (!el.chart || !el.box || !el.status) return;

    const state = {
      bases: { data: dataBases(win.location, 'data'), notes: dataBases(win.location, 'notes') },
      down: new Map(), // host -> time of its last network failure or timeout
      index: null,
      session: null,
      notes: null,
      notesError: '',
      date: dateParam(win.location.search),
      pending: null, // newest session date while the default view shows an older final session
      storyTimeline: false, // the story section currently shows the three-market timeline
      error: '',
      failures: 0,
      seq: 0,
      lastLoad: 0,
      timer: null,
      urlBefore: null, // the URL before a date switch that has not loaded yet
      panel: C.PANELS[0].key,
      prices: false,
      theme: doc.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark',
      layout: null,
      width: 0,
      cursor: null,
      tipPos: null,
      hover: false,
      exporting: false,
      optionsHtml: '',
      notesChecked: new Set(),
    };
    const logError = (error) => { if (win.console) win.console.error(error); };
    const chartApi = () => (win.ParallelChart && typeof win.ParallelChart.renderChart === 'function' ? win.ParallelChart : null);
    const displayWin = () => C.displayWindow(state.session, state.notes);

    // ------------------------------------------------ loading

    const describe = (error) => {
      const name = error && error.name;
      if (name === 'AbortError') return '응답 시간 초과';
      if (name === 'SyntaxError') return 'JSON 형식 오류';
      return (error && error.message) || '알 수 없는 오류';
    };

    /**
     * JSON from the first base that answers 200. optional: null when the file is absent (every base answered 404,
     * not counting bases on a host that was already down and failed again).
     */
    async function getJson(name, now, optional, kind) {
      const all = state.bases[kind] || state.bases.data;
      const left = all.slice();
      let lastError = null;
      let missing = 0;
      let unreachable = 0;
      while (left.length) {
        const base = orderBases(left, state.down, Date.now())[0];
        left.splice(left.indexOf(base), 1);
        const host = baseHost(base);
        const wasDown = hostDown(state.down, host, Date.now());
        const markDown = () => {
          if (wasDown) unreachable += 1;
          state.down.set(host, Date.now());
        };
        const ctrl = typeof win.AbortController === 'function' ? new win.AbortController() : null;
        const timer = ctrl ? win.setTimeout(() => ctrl.abort(), baseTimeout(!left.length)) : null;
        try {
          let res;
          try {
            res = await win.fetch(withMinute(base + name, now), { cache: 'no-store', signal: ctrl ? ctrl.signal : undefined });
          } catch (error) {
            markDown();
            // fetch() rejects with a TypeError ('Failed to fetch', 'Load failed', ...) when the request fails.
            throw error && error.name === 'AbortError' ? error : new Error('네트워크 오류');
          }
          state.down.delete(host);
          if (res.ok) {
            try {
              return await res.json();
            } catch (error) {
              if (error && error.name === 'AbortError') markDown();
              throw error;
            }
          }
          if (res.status === 404) missing += 1;
          lastError = new Error(`HTTP ${res.status}`);
        } catch (error) {
          lastError = error;
        } finally {
          if (timer) win.clearTimeout(timer);
        }
      }
      if (optional && missing > 0 && missing + unreachable === all.length) return null;
      throw lastError || new Error('응답 없음');
    }

    /** {date, session, error}: one session file, validated. */
    async function getSession(date, now) {
      try {
        const session = C.validateSession(await getJson(`sessions/${date}.json`, now, false, 'data'));
        if (session.date !== date) throw new Error(`날짜 불일치(${session.date})`);
        return { date, session, error: '' };
      } catch (error) {
        return { date, session: null, error: describe(error) };
      }
    }

    /**
     * The default view (no date chosen): the newest session; while it is still being collected with little data
     * and an older final session exists, that final session, with result.pending = the newest date.
     */
    async function getDefault(index, now) {
      const d = defaultDates(index);
      if (!d.newest) return { date: null, session: null, error: '' };
      if (!d.older) return getSession(d.newest, now);
      let newest = null;
      if (!d.thin) {
        newest = await getSession(d.newest, now);
        if (newest.session && !sparseSession(newest.session)) return newest;
      }
      const older = await getSession(d.older, now);
      if (older.session) return Object.assign(older, { pending: d.newest });
      return newest && newest.session ? newest : (newest || getSession(d.newest, now));
    }

    async function load() {
      const seq = ++state.seq;
      const now = Date.now();
      state.lastLoad = now;
      const problems = [];
      let index = state.index;
      try {
        index = C.validateIndex(await getJson('index.json', now, false, 'data'));
      } catch (error) {
        problems.push(`목록: ${describe(error)}`);
      }
      if (seq !== state.seq) return;
      state.index = index;
      const requested = state.date;
      let result = { date: null, session: null, error: '' };
      if (requested) result = await getSession(requested, now);
      else if (index && index.sessions.length) result = await getDefault(index, now);
      if (seq !== state.seq) return;
      const session = result.session;
      const date = result.date;

      // Notes: index.hasNotes can lag behind notes published after a session is final, so the file is requested
      // at least once per date; later refreshes skip it while the index says none and the last answer was a 404.
      let notes = null;
      let notesOk = true;
      let keepNotes = false;
      let notesError = '';
      if (session) {
        const entry = index ? index.sessions.find((s) => s.date === date) : null;
        if (entry && entry.hasNotes === false && state.notesChecked.has(date)) {
          keepNotes = true;
        } else {
          try {
            const raw = await getJson(`notes/${date}.json`, now, true, 'notes');
            notes = raw === null ? null : C.validateNotes(raw);
            if (notes && notes.date !== date) throw new Error(`날짜 불일치(${notes.date})`);
            state.notesChecked.add(date);
          } catch (error) {
            notesOk = false;
            notes = null;
            notesError = describe(error);
            state.notesChecked.delete(date);
            problems.push(`노트: ${notesError}`);
          }
          if (seq !== state.seq) return;
        }
      }

      let switchFailed = '';
      if (session) {
        const sameDate = state.session && state.session.date === session.date;
        if (!requested) state.pending = result.pending || null;
        state.notes = notesOk && !keepNotes ? notes : (sameDate ? state.notes : null);
        // The notice says why notes are missing only while none are shown; kept notes stay after a failed refresh.
        if (notesOk) state.notesError = '';
        else if (!state.notes) state.notesError = notesError;
        if (!sameDate) state.cursor = null;
        state.session = session;
        state.date = session.date;
        state.urlBefore = null;
      } else if (state.session && date && date !== state.session.date) {
        // A requested switch failed: the picker and the URL go back to the date still shown.
        switchFailed = `${shortDate(date)} 자료를 불러오지 못했습니다: ${result.error}`;
        state.date = state.session.date;
        state.optionsHtml = '';
        if (state.urlBefore !== null) {
          try {
            win.history.replaceState(null, '', state.urlBefore);
          } catch (error) { /* the URL stays as it was */ }
          state.urlBefore = null;
        }
      } else if (result.error) {
        problems.push(`세션: ${result.error}`);
        if (state.session) state.date = state.session.date; // keep showing the last good session
      } else if (!date && !problems.length) {
        problems.push('아직 수집된 날짜가 없습니다');
      }
      state.error = problems.join(' · ');
      state.failures = state.error ? state.failures + 1 : 0;
      renderAll();
      if (switchFailed) toolNote(switchFailed);
      schedule();
    }

    function schedule() {
      win.clearTimeout(state.timer);
      state.timer = null;
      const delay = nextDelay({ session: state.session, now: Date.now(), failures: state.failures, hidden: doc.visibilityState === 'hidden' });
      if (delay !== null) state.timer = win.setTimeout(load, delay);
    }

    doc.addEventListener('visibilitychange', () => {
      if (doc.visibilityState === 'hidden') {
        win.clearTimeout(state.timer);
        state.timer = null;
        return;
      }
      if (!state.failures && !pollsLive(state.session, Date.now())) return;
      if (Date.now() - state.lastLoad >= VISIBLE_RELOAD_GAP_MS) load();
      else schedule();
    });

    // ------------------------------------------------ rendering

    // Containers are rewritten only when their HTML changes, so a refresh with the same content keeps keyboard
    // focus; when it does change, focus moves to the element at the same position in the new content.
    const written = new WeakMap();
    function setHtml(box, html) {
      if (!box || written.get(box) === html) return false;
      const active = doc.activeElement;
      let spot = -1;
      if (active && active !== box && typeof box.contains === 'function' && box.contains(active)) {
        spot = Array.prototype.indexOf.call(box.querySelectorAll(FOCUSABLE), active);
      }
      box.innerHTML = html;
      written.set(box, html);
      if (spot >= 0) {
        const list = box.querySelectorAll(FOCUSABLE);
        const next = list[Math.min(spot, list.length - 1)];
        if (next && typeof next.focus === 'function') {
          try {
            next.focus({ preventScroll: true });
          } catch (error) { /* focus is best effort */ }
        }
      }
      return true;
    }

    function renderStatus() {
      const info = statusInfo({ session: state.session, error: state.error, now: Date.now() });
      if (el.status.textContent !== info.text) el.status.textContent = info.text;
      el.status.setAttribute('data-state', info.state);
      el.status.title = statusTitle(state.session, state.error);
    }

    function renderHeader() {
      const s = state.session;
      const n = state.notes;
      const title = titleText(n);
      el.title.textContent = title;
      el.meta.textContent = s ? metaText(s, n) : (state.error ? '자료를 불러오지 못했습니다.' : '자료를 불러오는 중입니다.');
      if (el.subtitle) {
        const sub = s ? subtitleText(s, n) : '';
        el.subtitle.textContent = sub;
        el.subtitle.hidden = !sub;
      }
      doc.title = s ? `${title} · ${shortDate(s.date)} | 병렬 타임라인` : '병렬 타임라인 | 지금 상황판';
      const options = dateOptionsHtml(state.index, s ? s.date : state.date, n && n.title)
        || (state.error ? '<option>날짜 목록 없음</option>' : '<option>날짜 불러오는 중</option>');
      if (options !== state.optionsHtml) {
        el.select.innerHTML = options;
        state.optionsHtml = options;
      }
      el.select.disabled = !state.index && !s;
      const canExport = !!(s && chartApi()) && !state.exporting;
      el.pngLight.disabled = !canExport;
      el.pngDark.disabled = !canExport;
    }

    function updateSlider() {
      if (!el.slider) return;
      const s = state.session;
      const ready = !!(s && state.layout);
      el.slider.hidden = !ready;
      el.slider.tabIndex = ready ? 0 : -1;
      if (!ready) return;
      const w = displayWin();
      const v = sliderValues(w, state.cursor === null ? latestTime(s, w) : state.cursor);
      el.slider.setAttribute('aria-valuemin', String(v.min));
      el.slider.setAttribute('aria-valuemax', String(v.max));
      el.slider.setAttribute('aria-valuenow', String(v.now));
      el.slider.setAttribute('aria-valuetext', v.text);
    }

    function renderChart(force) {
      const s = state.session;
      const api = chartApi();
      if (!s || !api) {
        state.layout = null;
        state.width = 0;
        let msg = '자료를 불러오는 중입니다.';
        if (s) msg = '차트 모듈을 불러오지 못했습니다.';
        else if (state.error) msg = `자료를 불러오지 못했습니다. ${state.error}`;
        el.chart.innerHTML = `<p class="chart-empty">${esc(msg)}</p>`;
        el.tip.hidden = true;
        el.help.hidden = true;
        updateSlider();
        return;
      }
      el.help.hidden = false;
      const width = Math.floor(el.chart.clientWidth);
      if (!width || (!force && width === state.width && state.layout)) {
        updateSlider();
        return;
      }
      try {
        const out = api.renderChart(s, state.notes, { width, theme: state.theme, header: false, compact: width < 640, now: s.final ? null : Date.now() });
        el.chart.innerHTML = out.svg;
        state.layout = out.layout;
        state.width = width;
      } catch (error) {
        logError(error);
        state.layout = null;
        el.chart.innerHTML = '<p class="chart-empty">차트를 그리지 못했습니다.</p>';
      }
      drawCursor(state.tipPos);
      updateSlider();
    }

    function setSection(section, box, html) {
      setHtml(box, html);
      section.hidden = !html;
    }

    /** Story: the time-scaled three-market timeline when the notes are tagged for it and the page is wide enough, else the paragraph list. */
    function renderStory(n, s) {
      const wide = Math.floor(el.box.clientWidth || 0) >= STL_MIN_WIDTH;
      const html = (wide && s ? storyTimelineHtml(n, s.date) : '') || storyHtml(n);
      const timeline = wide && !!(s && storyTimelineHtml(n, s.date));
      el.storySec.classList.toggle('stl-wide', timeline);
      const changed = setHtml(el.story, html);
      el.storySec.hidden = !html;
      state.storyTimeline = timeline;
      if (timeline && (changed || !el.story.querySelector('svg.stl-links'))) {
        const run = () => {
          try {
            if (state.storyTimeline) layoutStoryTimeline(el.story, win);
          } catch (error) {
            logError(error);
          }
        };
        run();
        const fonts = win.document && win.document.fonts;
        if (fonts && fonts.ready && typeof fonts.ready.then === 'function') fonts.ready.then(run, () => {});
      }
    }

    function renderTable() {
      for (const b of el.seg.querySelectorAll('button[data-panel]')) {
        b.setAttribute('aria-pressed', String(b.getAttribute('data-panel') === state.panel));
      }
      if (el.unit) {
        for (const b of el.unit.querySelectorAll('button[data-unit]')) {
          b.setAttribute('aria-pressed', String((b.getAttribute('data-unit') === 'price') === state.prices));
        }
      }
      const s = state.session;
      const w = s ? displayWin() : null;
      el.basis.textContent = tableBasisText(s, state.panel, w, state.prices);
      setHtml(el.table, s ? timetableHtml(s, state.panel, w, { prices: state.prices }) : '');
    }

    function renderPending() {
      if (!el.pending) return;
      const html = state.pending && (!state.session || state.pending !== state.session.date) ? pendingNoticeHtml(state.pending, Date.now()) : '';
      setHtml(el.pending, html);
      el.pending.hidden = !html;
    }

    function renderBody() {
      const s = state.session;
      const n = state.notes;
      el.duo.hidden = !s;
      el.noNotes.hidden = !s || !!n;
      if (s && !n) el.noNotes.textContent = notesNotice(state.notesError);
      renderPending();
      el.caption.textContent = s ? captionText(s) : '';
      if (el.caption.parentElement) el.caption.parentElement.hidden = !s;
      if (!s) {
        for (const [section, box] of [[el.headlineSec, el.headline], [el.sectionsSec, el.sections], [el.watchSec, el.watch],
          [el.storySec, el.story], [el.verdictSec, el.verdict], [el.eventsSec, el.events]]) setSection(section, box, '');
      } else {
        const w = displayWin();
        let auto = [];
        let basis = '';
        try {
          auto = C.insights(s, n, w);
          basis = typeof C.insightsBasis === 'function' ? C.insightsBasis(s, n, w) : '';
        } catch (error) {
          logError(error);
        }
        setSection(el.headlineSec, el.headline, headlineHtml(n));
        setHtml(el.obs, insightsHtml(n, auto, basis) || '<li class="empty">아직 표시할 항목이 없습니다.</li>');
        renderTable();
        setSection(el.sectionsSec, el.sections, sectionsHtml(n));
        setSection(el.watchSec, el.watch, watchHtml(n));
        renderStory(n, s);
        setSection(el.verdictSec, el.verdict, verdictHtml(n));
        setSection(el.eventsSec, el.events, eventsHtml(n, w));
      }
      const before = el.foot.querySelector('details');
      const open = !!(before && before.open);
      if (setHtml(el.foot, footerHtml(s, n)) && open) {
        const details = el.foot.querySelector('details');
        if (details) details.open = true;
      }
    }

    function renderAll() {
      renderStatus();
      renderHeader();
      try {
        renderBody();
      } catch (error) {
        logError(error);
      }
      renderChart(true);
    }

    // ------------------------------------------------ crosshair and tooltip

    function placeTip(xSvg, pos) {
      const svg = el.chart.querySelector('svg');
      if (!svg || !state.layout) return;
      const boxRect = el.box.getBoundingClientRect();
      const r = svg.getBoundingClientRect();
      const scale = r.width / state.layout.width || 1;
      const x = r.left - boxRect.left + xSvg * scale;
      const bw = el.box.clientWidth;
      const bh = el.box.clientHeight;
      const tw = el.tip.offsetWidth;
      const th = el.tip.offsetHeight;
      let left = x + 16;
      if (left + tw > bw - 4) left = x - 16 - tw;
      if (left < 4) left = Math.min(Math.max(4, x - tw / 2), Math.max(4, bw - tw - 4));
      const visTop = Math.max(0, -boxRect.top);
      const visBottom = Math.min(bh, win.innerHeight - boxRect.top);
      let top;
      if (pos && Number.isFinite(pos.y)) {
        top = pos.touch ? pos.y - th - 28 : pos.y - th / 2;
        if (pos.touch && top < visTop + 4) top = pos.y + 28;
      } else {
        top = visTop + 12;
      }
      top = Math.min(top, visBottom - th - 4);
      top = Math.max(top, visTop + 4);
      top = Math.min(Math.max(top, 0), Math.max(0, bh - th));
      el.tip.style.left = `${Math.round(left)}px`;
      el.tip.style.top = `${Math.round(top)}px`;
    }

    function drawCursor(pos) {
      const svg = el.chart.querySelector('svg');
      const old = svg && svg.querySelector('.pv-xhair');
      if (old) old.remove();
      if (state.cursor === null || !svg || !state.layout || !state.session) {
        el.tip.hidden = true;
        return;
      }
      const marks = cursorMarks(state.layout, state.session, state.cursor);
      const g = doc.createElementNS(SVG_NS, 'g');
      g.setAttribute('class', 'pv-xhair');
      g.setAttribute('aria-hidden', 'true');
      g.setAttribute('pointer-events', 'none');
      for (const ln of marks.lines) {
        const line = doc.createElementNS(SVG_NS, 'line');
        line.setAttribute('x1', marks.x);
        line.setAttribute('x2', marks.x);
        line.setAttribute('y1', ln.y1);
        line.setAttribute('y2', ln.y2);
        g.appendChild(line);
      }
      for (const d of marks.dots) {
        const dot = doc.createElementNS(SVG_NS, 'circle');
        dot.setAttribute('cx', d.cx);
        dot.setAttribute('cy', d.cy);
        dot.setAttribute('r', '3.6');
        dot.setAttribute('fill', d.color);
        g.appendChild(dot);
      }
      svg.appendChild(g);
      el.tip.innerHTML = tooltipHtml(state.session, state.cursor);
      el.tip.classList.toggle('is-narrow', el.box.clientWidth < NARROW_TIP_BELOW);
      el.tip.hidden = false;
      placeTip(marks.x, pos);
    }

    function hideCursor() {
      state.cursor = null;
      state.tipPos = null;
      drawCursor(null);
      updateSlider();
    }

    function setCursor(t, pos) {
      state.tipPos = pos;
      if (t === state.cursor && !el.tip.hidden) {
        placeTip(timeToX(state.layout, t), pos);
        return;
      }
      state.cursor = t;
      drawCursor(pos);
      updateSlider();
    }

    function onPointer(ev) {
      const svg = el.chart.querySelector('svg');
      if (!svg || !state.layout || !state.session) return;
      const r = svg.getBoundingClientRect();
      if (!r.width) return;
      const x = ((ev.clientX - r.left) * state.layout.width) / r.width;
      const t = snapTime(state.session, displayWin(), xToTime(state.layout, x));
      setCursor(t, { y: ev.clientY - el.box.getBoundingClientRect().top, touch: ev.pointerType === 'touch' });
    }

    let announceTimer = null;
    function announce() {
      win.clearTimeout(announceTimer);
      announceTimer = win.setTimeout(() => {
        if (state.cursor !== null && state.session) el.live.textContent = readoutText(state.session, state.cursor);
      }, 250);
    }

    // The keyboard control is a separate role="slider" element (the chart image keeps its own summary): screen
    // readers switch to focus mode on a slider, so the arrow keys reach this handler.
    const keyTarget = el.slider || el.box;
    el.box.addEventListener('pointerenter', (ev) => { if (ev.pointerType === 'mouse') state.hover = true; });
    el.box.addEventListener('pointermove', (ev) => { if (ev.pointerType !== 'touch' || ev.buttons) onPointer(ev); });
    el.box.addEventListener('pointerdown', onPointer);
    el.box.addEventListener('pointerleave', (ev) => {
      if (ev.pointerType !== 'mouse') return;
      state.hover = false;
      if (doc.activeElement !== keyTarget) hideCursor();
    });
    doc.addEventListener('pointerdown', (ev) => { if (!el.box.contains(ev.target)) hideCursor(); });
    keyTarget.addEventListener('focus', () => {
      if (state.cursor === null && state.session && state.layout) {
        state.cursor = latestTime(state.session, displayWin());
        state.tipPos = null;
        drawCursor(null);
        updateSlider();
        announce();
      }
    });
    keyTarget.addEventListener('blur', () => { if (!state.hover) hideCursor(); });
    keyTarget.addEventListener('keydown', (ev) => {
      if (!state.session || !state.layout) return;
      const w = displayWin();
      const step = intervalOf(state.session) * MINUTE;
      const current = state.cursor === null ? latestTime(state.session, w) : state.cursor;
      let t;
      if (ev.key === 'ArrowRight' || ev.key === 'ArrowUp') t = current + step;
      else if (ev.key === 'ArrowLeft' || ev.key === 'ArrowDown') t = current - step;
      else if (ev.key === 'Home') t = w.start;
      else if (ev.key === 'End') t = w.end;
      else if (ev.key === 'Escape') {
        hideCursor();
        return;
      } else return;
      ev.preventDefault();
      setCursor(snapTime(state.session, w, t), null);
      announce();
    });

    // ------------------------------------------------ controls

    el.seg.innerHTML = C.PANELS.map((p) => `<button type="button" data-panel="${esc(p.key)}" aria-pressed="${p.key === state.panel}">${esc(PANEL_SHORT[p.key] || p.label)}</button>`).join('');
    el.seg.addEventListener('click', (ev) => {
      const b = ev.target.closest('button[data-panel]');
      if (!b || b.getAttribute('data-panel') === state.panel) return;
      state.panel = b.getAttribute('data-panel');
      renderTable();
    });
    if (el.unit) {
      el.unit.addEventListener('click', (ev) => {
        const b = ev.target.closest('button[data-unit]');
        const prices = !!b && b.getAttribute('data-unit') === 'price';
        if (!b || prices === state.prices) return;
        state.prices = prices;
        renderTable();
      });
    }

    let noteTimer = null;
    function toolNote(text) {
      win.clearTimeout(noteTimer);
      el.note.textContent = text;
      if (text) noteTimer = win.setTimeout(() => { el.note.textContent = ''; }, 6000);
    }

    /** Load another date chosen by the reader (select or notice link); the URL follows unless the load fails. */
    function switchDate(d) {
      if (!ymd(d)) return;
      state.pending = null;
      if (state.session && d === state.session.date && !state.urlBefore) {
        renderPending();
        return;
      }
      if (state.urlBefore === null) state.urlBefore = String(win.location.href);
      state.date = d;
      state.cursor = null;
      try {
        const url = new win.URL(win.location.href);
        url.searchParams.set('date', d);
        win.history.replaceState(null, '', url.toString());
      } catch (error) { /* the URL stays as it was */ }
      load();
    }

    el.select.addEventListener('change', () => switchDate(el.select.value));
    if (el.pending) {
      el.pending.addEventListener('click', (ev) => {
        const a = ev.target && typeof ev.target.closest === 'function' ? ev.target.closest('a[data-date]') : null;
        if (!a || ev.defaultPrevented || ev.button > 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
        ev.preventDefault();
        switchDate(a.getAttribute('data-date'));
      });
    }

    function applyTheme() {
      doc.documentElement.setAttribute('data-theme', state.theme);
      el.theme.setAttribute('aria-pressed', String(state.theme === 'light'));
    }
    el.theme.addEventListener('click', () => {
      state.theme = state.theme === 'light' ? 'dark' : 'light';
      applyTheme();
      try {
        win.localStorage.setItem(THEME_KEY, state.theme);
      } catch (error) { /* storage blocked: the choice lasts for this page only */ }
      renderChart(true);
    });
    applyTheme();

    async function exportPng(theme, button) {
      const s = state.session;
      const api = chartApi();
      if (!s || !api || state.exporting) return;
      state.exporting = true;
      button.setAttribute('aria-busy', 'true');
      el.pngLight.disabled = true;
      el.pngDark.disabled = true;
      try {
        const out = api.renderChart(s, state.notes, {
          width: PNG_WIDTH, theme, header: true, compact: false, now: s.final ? null : Date.now(), idPrefix: 'pchartpng',
          footer: pngFooter(s, state.notes),
        });
        const blob = await rasterize(win, out.svg, out.layout, PNG_SCALE);
        const name = pngFileName(s.date, theme, s);
        saveBlob(win, blob, name);
        toolNote(`PNG를 저장했습니다: ${name}`);
      } catch (error) {
        logError(error);
        toolNote(`PNG를 만들지 못했습니다: ${describe(error)}`);
      } finally {
        state.exporting = false;
        button.removeAttribute('aria-busy');
        renderHeader();
      }
    }
    el.pngLight.addEventListener('click', () => exportPng('light', el.pngLight));
    el.pngDark.addEventListener('click', () => exportPng('dark', el.pngDark));

    // ------------------------------------------------ resize

    let resizeTimer = null;
    const onResize = () => {
      win.clearTimeout(resizeTimer);
      resizeTimer = win.setTimeout(() => {
        if (state.session && Math.floor(el.chart.clientWidth) !== state.width) renderChart(false);
        if (state.session) {
          try {
            const wide = Math.floor(el.box.clientWidth || 0) >= STL_MIN_WIDTH;
            if (wide !== !!state.storyTimeline && storyTimelineModel(state.notes)) renderStory(state.notes, state.session);
            else if (state.storyTimeline) layoutStoryTimeline(el.story, win);
          } catch (error) {
            logError(error);
          }
        }
      }, 150);
    };
    if (typeof win.ResizeObserver === 'function') new win.ResizeObserver(onResize).observe(el.chart);
    else win.addEventListener('resize', onResize);

    renderAll();
    load();
  }

  return {
    start,
    dataBases, baseHost, orderBases, baseTimeout, withMinute, dateParam,
    thinEntry, sparseSession, defaultDates, pollsLive, nextDelay,
    statusInfo, statusText, statusTitle, titleText, metaText, subtitleText, dateOptionsHtml, pendingNoticeHtml,
    notesNotice, pngFileName, pngFooter,
    shortDate, longDate, safeUrl,
    headlineHtml, insightsHtml, sectionsHtml, watchHtml, storyHtml, verdictHtml, eventsHtml,
    storyTimelineModel, storyTimelineHtml, timelineScale, layoutStoryTimeline,
    timetableHtml, tableBasisText, captionText, baselineNotes, providerNames, footerHtml,
    panelSeries, colorSlots, plotBounds, timeToX, xToTime, snapTime, latestTime, sliderValues, cursorMarks,
    tooltipHtml, readoutText, svgSize,
  };
});
