/* Parallel timeline core (병렬 타임라인 v3).
 * Pure helpers shared by the collector (Node) and the chart/page (browser):
 * constants, KST time helpers, number formatting, data-contract validators,
 * series math, chart layout helpers and the automatic "what the chart shows" bullets.
 * No DOM access and no clock reads: every time-dependent function takes its inputs explicitly.
 * Data contract: docs/parallel-timeline.md (schemaVersion 3).
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ParallelCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MINUTE = 60000;
  const HOUR = 60 * MINUTE;
  const KST_OFFSET_MS = 9 * 3600e3;
  const MAX_TEXT = 4000;
  const MINUS = '\u2212'; // true minus sign
  const NO_VALUE = '\u2013'; // shown for a missing number

  function deepFreeze(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
      Object.freeze(value);
      for (const key of Object.keys(value)) deepFreeze(value[key]);
    }
    return value;
  }

  // ---------------------------------------------------------------- constants

  /** Panels in display order: key, title and the muted basis suffix shown after the title. */
  const PANELS = deepFreeze([
    { key: 'indices', label: '주식지수', suffix: '(전일 종가 대비 %)' },
    { key: 'ai', label: 'AI·반도체 종목', suffix: '(전일 종가 대비 %)' },
    { key: 'crypto', label: '크립토', suffix: '(08:00 KST 대비 %)' },
    { key: 'fx', label: '달러·금', suffix: '(08:00 KST 대비 %)' },
  ]);
  const PANEL_KEYS = PANELS.map((p) => p.key);

  const yahoo = (symbol) => ({ provider: 'yahoo', symbol });
  const coinmetrics = (symbol) => ({ provider: 'coinmetrics', symbol });
  const def = (id, panel, label, basis, sources, closeKst) =>
    ({ id, panel, label, basis, sources, closeKst: closeKst || null });

  /** Series catalog in display order; sources are listed in priority order, closeKst is the official close print time. */
  const SERIES = deepFreeze([
    def('kospi', 'indices', '코스피', 'prevClose', [yahoo('^KS11')], '15:30'),
    def('nikkei', 'indices', '니케이225', 'prevClose', [yahoo('^N225')], '15:30'),
    def('taiex', 'indices', '대만 가권', 'prevClose', [yahoo('^TWII')], '14:30'),
    def('hsi', 'indices', '항셍', 'prevClose', [yahoo('^HSI')], '17:10'),
    def('nq', 'indices', '나스닥100 선물', 'windowStart', [yahoo('NQ=F')]),
    def('skhynix', 'ai', 'SK하이닉스', 'prevClose', [yahoo('000660.KS')], '15:30'),
    def('samsung', 'ai', '삼성전자', 'prevClose', [yahoo('005930.KS')], '15:30'),
    def('tsmc', 'ai', 'TSMC', 'prevClose', [yahoo('2330.TW')], '14:30'),
    def('softbank', 'ai', '소프트뱅크', 'prevClose', [yahoo('9984.T')], '15:30'),
    def('advantest', 'ai', '어드반테스트', 'prevClose', [yahoo('6857.T')], '15:30'),
    def('btc', 'crypto', 'BTC', 'windowStart', [coinmetrics('btc'), yahoo('BTC-USD')]),
    def('eth', 'crypto', 'ETH', 'windowStart', [coinmetrics('eth'), yahoo('ETH-USD')]),
    def('hype', 'crypto', 'HYPE', 'windowStart', [coinmetrics('hype'), yahoo('HYPE32196-USD')]),
    def('zec', 'crypto', 'ZEC', 'windowStart', [coinmetrics('zec'), yahoo('ZEC-USD')]),
    def('xmr', 'crypto', 'XMR', 'windowStart', [coinmetrics('xmr'), yahoo('XMR-USD')]),
    def('dxy', 'fx', '달러지수', 'windowStart', [yahoo('DX-Y.NYB')]),
    def('usdkrw', 'fx', '달러/원', 'windowStart', [yahoo('KRW=X')]),
    def('usdjpy', 'fx', '달러/엔', 'windowStart', [yahoo('JPY=X')]),
    def('gold', 'fx', '금 선물', 'windowStart', [yahoo('GC=F')]),
  ]);

  /** Line colors by index within a panel (5 max), per theme. */
  const COLORS = deepFreeze({
    light: ['#2f74d0', '#e4632d', '#16a077', '#e0a106', '#de6fa8'],
    dark: ['#6aa6f5', '#f2875a', '#3fcb9d', '#f2c14a', '#f08cc0'],
  });

  /** Provider descriptions written into every session file. */
  const PROVIDERS = deepFreeze([
    { id: 'yahoo', label: 'Yahoo Finance', url: 'https://finance.yahoo.com/',
      note: '15분봉 · 개인 비상업 열람용 · 거래소별 지연 가능' },
    { id: 'coinmetrics', label: 'Coin Metrics Community', url: 'https://coinmetrics.io/community-network-data/',
      license: 'CC BY-NC 4.0', licenseUrl: 'https://creativecommons.org/licenses/by-nc/4.0/',
      note: 'ReferenceRateUSD 1분 기준가격의 15분 시각 표본' },
  ]);

  const STATUSES = deepFreeze(['ok', 'stale', 'missing', 'error']);
  const BASES = deepFreeze(['prevClose', 'windowStart']);
  const EVENT_KINDS = deepFreeze(['call', 'projection', 'statement', 'concession', 'prediction', 'band', 'other']);

  // ---------------------------------------------------------------- time

  const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
  const HHMM_RE = /^(\d{2}):(\d{2})$/;
  const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?Z$/;

  /** Epoch ms from an ISO string, a Date or a number (NaN when unusable). */
  function toMs(x) {
    if (typeof x === 'number') return x;
    if (typeof x === 'string') return Date.parse(x);
    if (x instanceof Date) return x.getTime();
    return NaN;
  }

  function finiteMs(x, fn) {
    const ms = toMs(x);
    if (!Number.isFinite(ms)) throw new TypeError(`${fn}: invalid time ${show(x)}`);
    return ms;
  }

  /** ISO UTC string ending in Z, without milliseconds when they are zero. */
  function isoUtc(ms) {
    const s = new Date(finiteMs(ms, 'isoUtc')).toISOString();
    return s.endsWith('.000Z') ? `${s.slice(0, 19)}Z` : s;
  }

  /** KST calendar date 'YYYY-MM-DD' of an instant. */
  function kstDate(isoOrMs) {
    return new Date(finiteMs(isoOrMs, 'kstDate') + KST_OFFSET_MS).toISOString().slice(0, 10);
  }

  /** KST wall-clock time 'HH:MM' of an instant (seconds truncated). */
  function kstTime(isoOrMs) {
    return new Date(finiteMs(isoOrMs, 'kstTime') + KST_OFFSET_MS).toISOString().slice(11, 16);
  }

  function parseDate(date) {
    const m = typeof date === 'string' ? DATE_RE.exec(date) : null;
    if (!m) return null;
    const ms = Date.UTC(+m[1], +m[2] - 1, +m[3]);
    return new Date(ms).toISOString().slice(0, 10) === date ? ms : null;
  }

  // Minutes after midnight for 'HH:MM' (00:00..24:00), else null.
  function parseHHMM(hhmm) {
    const m = typeof hhmm === 'string' ? HHMM_RE.exec(hhmm) : null;
    if (!m) return null;
    const h = +m[1];
    const min = +m[2];
    if (min > 59 || h > 24 || (h === 24 && min !== 0)) return null;
    return h * 60 + min;
  }

  /** UTC ISO instant of a KST wall-clock time on a KST date, e.g. ('2026-11-04','08:00') -> '2026-11-03T23:00:00Z'. */
  function kstToUtcIso(date, hhmm) {
    const day = parseDate(date);
    if (day === null) throw new TypeError(`kstToUtcIso: invalid date ${show(date)} (expected YYYY-MM-DD)`);
    const min = parseHHMM(hhmm);
    if (min === null) throw new TypeError(`kstToUtcIso: invalid time ${show(hhmm)} (expected HH:MM)`);
    return isoUtc(day + min * MINUTE - KST_OFFSET_MS);
  }

  /** Session window {start, end} (ISO Z) for a KST date, default 08:00–16:00 KST. */
  function sessionWindow(date, startHHMM, endHHMM) {
    const startText = startHHMM == null ? '08:00' : startHHMM;
    const endText = endHHMM == null ? '16:00' : endHHMM;
    const start = kstToUtcIso(date, startText);
    const end = kstToUtcIso(date, endText);
    if (!(Date.parse(start) < Date.parse(end))) {
      throw new RangeError(`sessionWindow: end ${endText} must be after start ${startText}`);
    }
    return { start, end };
  }

  function normWin(win) {
    return { start: toMs(win.start), end: toMs(win.end) };
  }

  // ---------------------------------------------------------------- numbers

  // |x| * 10^digits rounded half away from zero, robust to binary noise (1.005 -> 101 at 2 digits).
  function scaledAbs(x, digits) {
    return Math.round(Number((Math.abs(x) * Math.pow(10, digits)).toPrecision(12)));
  }

  function decimalString(n, digits) {
    if (!digits) return String(n);
    const s = String(n).padStart(digits + 1, '0');
    return `${s.slice(0, -digits)}.${s.slice(-digits)}`;
  }

  function normDigits(digits, fallback) {
    return Number.isInteger(digits) && digits >= 0 && digits <= 10 ? digits : fallback;
  }

  function signedText(p, digits, suffix) {
    if (typeof p !== 'number' || !Number.isFinite(p)) return NO_VALUE;
    const n = scaledAbs(p, digits);
    const body = decimalString(n, digits) + suffix;
    if (n === 0) return body;
    return (p < 0 ? MINUS : '+') + body;
  }

  /** Percent with explicit sign and U+2212 minus: '+1.2%', '−0.4%', '0.0%' when it rounds to zero. */
  function formatPct(p, digits) {
    return signedText(p, normDigits(digits, 1), '%');
  }

  /** Signed percentage-point change: '+1.2p', '−0.4p', '0.0p' when it rounds to zero. */
  function formatSignedPp(p, digits) {
    return signedText(p, normDigits(digits, 1), 'p');
  }

  /** Price text: >=1000 up to 2 decimals with thousands separators, >=1 two decimals, <1 four significant digits. */
  function formatValue(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return NO_VALUE;
    const a = Math.abs(value);
    if (a === 0) return '0';
    let digits = 2;
    if (a < 1) digits = 3 - Math.floor(Math.log10(a));
    let s = decimalString(scaledAbs(a, digits), digits);
    if (a >= 1000) s = s.replace(/\.?0+$/, '');
    const dot = s.indexOf('.');
    const whole = dot < 0 ? s : s.slice(0, dot);
    return (value < 0 ? MINUS : '') + whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (dot < 0 ? '' : s.slice(dot));
  }

  /** Percent change of value against base, rounded to 3 decimals (the session file's pct). */
  function pctChange(value, base) {
    if (!(Number.isFinite(value) && Number.isFinite(base) && value > 0 && base > 0)) return NaN;
    const x = 100 * (value / base - 1);
    const n = scaledAbs(x, 3);
    return n === 0 ? 0 : (x < 0 ? -n : n) / 1000;
  }

  // ---------------------------------------------------------------- validation

  function show(v) {
    let s;
    try { s = JSON.stringify(v); } catch (error) { s = String(v); }
    if (s === undefined) s = String(v);
    return s.length > 60 ? `${s.slice(0, 57)}...` : s;
  }
  function fail(path, reason) { throw new Error(`${path}: ${reason}`); }
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const given = (v) => v !== undefined && v !== null;

  function isIsoUtc(s) {
    if (typeof s !== 'string' || !ISO_RE.test(s)) return false;
    const ms = Date.parse(s);
    return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 16) === s.slice(0, 16);
  }
  function needObj(v, path) { if (!isObj(v)) fail(path, 'expected an object'); return v; }
  function needArr(v, path) { if (!Array.isArray(v)) fail(path, 'expected an array'); return v; }
  function needText(v, path, nonEmpty) {
    if (typeof v !== 'string') fail(path, 'expected a string');
    if (v.length > MAX_TEXT) fail(path, `longer than ${MAX_TEXT} characters`);
    if (nonEmpty && !v.trim()) fail(path, 'must not be empty');
    return v;
  }
  function optText(obj, key, path) { if (given(obj[key])) needText(obj[key], `${path}.${key}`); }
  function needTime(v, path) {
    if (!isIsoUtc(v)) fail(path, `expected an ISO UTC time ending in Z, got ${show(v)}`);
    return Date.parse(v);
  }
  function needDate(v, path) {
    if (parseDate(v) === null) fail(path, `expected a YYYY-MM-DD date, got ${show(v)}`);
    return v;
  }
  function needUrl(v, path) {
    let ok = typeof v === 'string' && v.length <= MAX_TEXT && /^https:\/\/\S+$/.test(v);
    if (ok && typeof URL === 'function') {
      try { ok = new URL(v).protocol === 'https:'; } catch (error) { ok = false; }
    }
    if (!ok) fail(path, `expected an https:// URL, got ${show(v)}`);
    return v;
  }
  function needBool(v, path) { if (typeof v !== 'boolean') fail(path, 'expected true or false'); return v; }
  function needHeader(obj, path, kind) {
    needObj(obj, path);
    if (obj.schemaVersion !== 3) fail(`${path}.schemaVersion`, `expected 3, got ${show(obj.schemaVersion)}`);
    if (obj.kind !== kind) fail(`${path}.kind`, `expected '${kind}', got ${show(obj.kind)}`);
    needDate(obj.date, `${path}.date`);
  }
  function textList(v, path) {
    needArr(v, path).forEach((item, i) => needText(item, `${path}[${i}]`));
  }

  /** Validate data/parallel/index.json; returns the same object or throws Error('path: reason'). */
  function validateIndex(obj) {
    const P = 'index';
    needObj(obj, P);
    if (obj.schemaVersion !== 3) fail(`${P}.schemaVersion`, `expected 3, got ${show(obj.schemaVersion)}`);
    if (obj.kind !== 'index') fail(`${P}.kind`, `expected 'index', got ${show(obj.kind)}`);
    needTime(obj.updatedAt, `${P}.updatedAt`);
    let previous = null;
    needArr(obj.sessions, `${P}.sessions`).forEach((entry, i) => {
      const q = `${P}.sessions[${i}]`;
      needObj(entry, q);
      needDate(entry.date, `${q}.date`);
      if (previous !== null && !(entry.date < previous)) {
        fail(`${q}.date`, 'sessions must be sorted by date, newest first, without duplicates');
      }
      previous = entry.date;
      needBool(entry.final, `${q}.final`);
      optText(entry, 'title', q);
      if (given(entry.seriesWithData) && !(Number.isInteger(entry.seriesWithData) && entry.seriesWithData >= 0)) {
        fail(`${q}.seriesWithData`, 'expected a non-negative integer');
      }
      if (given(entry.updatedAt)) needTime(entry.updatedAt, `${q}.updatedAt`);
      if (given(entry.hasNotes)) needBool(entry.hasNotes, `${q}.hasNotes`);
    });
    return obj;
  }

  function validateSeries(s, q, ws, we, ids) {
    needObj(s, q);
    needText(s.id, `${q}.id`, true);
    if (ids.has(s.id)) fail(`${q}.id`, `duplicate series id '${s.id}'`);
    ids.add(s.id);
    if (PANEL_KEYS.indexOf(s.panel) < 0) fail(`${q}.panel`, `unknown panel ${show(s.panel)}`);
    needText(s.label, `${q}.label`, true);
    if (BASES.indexOf(s.basis) < 0) fail(`${q}.basis`, `expected one of ${BASES.join('|')}, got ${show(s.basis)}`);
    if (STATUSES.indexOf(s.status) < 0) fail(`${q}.status`, `expected one of ${STATUSES.join('|')}, got ${show(s.status)}`);
    const empty = s.status === 'missing' || s.status === 'error';
    needObj(s.baseline, `${q}.baseline`);
    const base = s.baseline.value;
    if (base === null) {
      if (!empty) fail(`${q}.baseline.value`, `null is allowed only when status is missing or error (status '${s.status}')`);
    } else if (typeof base !== 'number' || !Number.isFinite(base) || base <= 0) {
      fail(`${q}.baseline.value`, `expected a positive number or null, got ${show(base)}`);
    }
    needText(s.baseline.label, `${q}.baseline.label`);
    if (given(s.source)) {
      needObj(s.source, `${q}.source`);
      needText(s.source.provider, `${q}.source.provider`, true);
      needText(s.source.symbol, `${q}.source.symbol`, true);
    }
    optText(s, 'note', q);
    if (given(s.fetchedAt)) needTime(s.fetchedAt, `${q}.fetchedAt`);
    needArr(s.points, `${q}.points`);
    if (empty && s.points.length) fail(`${q}.points`, `must be empty when status is '${s.status}'`);
    let previous = -Infinity;
    s.points.forEach((pt, j) => {
      const r = `${q}.points[${j}]`;
      if (!Array.isArray(pt) || pt.length < 3) fail(r, 'expected [time, value, pct]');
      const t = needTime(pt[0], `${r}[0]`);
      if (t <= previous) fail(r, 'times must be strictly ascending');
      if (t < ws || t > we) fail(r, `time ${pt[0]} is outside the session window`);
      previous = t;
      const value = pt[1];
      const pct = pt[2];
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        fail(`${r}[1]`, `value must be a positive finite number, got ${show(value)}`);
      }
      if (typeof pct !== 'number' || !Number.isFinite(pct)) fail(`${r}[2]`, `pct must be a finite number, got ${show(pct)}`);
      const expected = 100 * (value / base - 1);
      if (Math.abs(pct - expected) > 0.01 + 1e-9) {
        fail(`${r}[2]`, `pct ${pct} does not match value/baseline (${pctChange(value, base)})`);
      }
    });
  }

  /** Validate a session file (data/parallel/sessions/YYYY-MM-DD.json); returns the same object or throws. */
  function validateSession(obj) {
    const P = 'session';
    needHeader(obj, P, 'session');
    if (given(obj.timezone) && obj.timezone !== 'Asia/Seoul') fail(`${P}.timezone`, `expected 'Asia/Seoul', got ${show(obj.timezone)}`);
    needObj(obj.window, `${P}.window`);
    const ws = needTime(obj.window.start, `${P}.window.start`);
    const we = needTime(obj.window.end, `${P}.window.end`);
    if (!(ws < we)) fail(`${P}.window`, 'start must be before end');
    if (we - ws > 24 * HOUR) fail(`${P}.window`, 'span must be 24 hours or less');
    if (kstDate(ws) !== obj.date) fail(`${P}.window.start`, `must fall on the session date ${obj.date} (KST)`);
    if (given(obj.intervalMinutes) && !(Number.isInteger(obj.intervalMinutes) && obj.intervalMinutes > 0)) {
      fail(`${P}.intervalMinutes`, 'expected a positive integer');
    }
    needTime(obj.generatedAt, `${P}.generatedAt`);
    needBool(obj.final, `${P}.final`);
    const ids = new Set();
    needArr(obj.series, `${P}.series`).forEach((s, i) => validateSeries(s, `${P}.series[${i}]`, ws, we, ids));
    if (given(obj.providers)) {
      needArr(obj.providers, `${P}.providers`).forEach((p, i) => {
        const q = `${P}.providers[${i}]`;
        needObj(p, q);
        needText(p.id, `${q}.id`, true);
        needText(p.label, `${q}.label`, true);
        needUrl(p.url, `${q}.url`);
        optText(p, 'license', q);
        if (given(p.licenseUrl)) needUrl(p.licenseUrl, `${q}.licenseUrl`);
        optText(p, 'note', q);
      });
    }
    return obj;
  }

  function validateEvent(e, q, ids) {
    needObj(e, q);
    if (given(e.id)) {
      needText(e.id, `${q}.id`, true);
      if (ids.has(e.id)) fail(`${q}.id`, `duplicate event id '${e.id}'`);
      ids.add(e.id);
    }
    const at = needTime(e.at, `${q}.at`);
    needText(e.label, `${q}.label`, true);
    optText(e, 'sub', q);
    optText(e, 'source', q);
    optText(e, 'detail', q);
    if (given(e.kind) && EVENT_KINDS.indexOf(e.kind) < 0) {
      fail(`${q}.kind`, `expected one of ${EVENT_KINDS.join('|')}, got ${show(e.kind)}`);
    }
    if (given(e.end)) {
      if (needTime(e.end, `${q}.end`) <= at) fail(`${q}.end`, 'must be after at');
    } else if (e.kind === 'band') {
      fail(`${q}.end`, 'a band needs an end time');
    }
    if (given(e.url)) needUrl(e.url, `${q}.url`);
    if (given(e.alts)) {
      needArr(e.alts, `${q}.alts`).forEach((alt, k) => {
        const r = `${q}.alts[${k}]`;
        needObj(alt, r);
        needText(alt.source, `${r}.source`, true);
        if (given(alt.at)) needTime(alt.at, `${r}.at`);
        if (given(alt.url)) needUrl(alt.url, `${r}.url`);
      });
    }
  }

  /** Validate an analyst notes file (data/parallel/notes/YYYY-MM-DD.json); returns the same object or throws. */
  function validateNotes(obj) {
    const P = 'notes';
    needHeader(obj, P, 'notes');
    for (const key of ['title', 'subtitle', 'author', 'headline', 'verdict', 'footnote']) optText(obj, key, P);
    if (given(obj.asOf)) needTime(obj.asOf, `${P}.asOf`);
    if (given(obj.display)) {
      needObj(obj.display, `${P}.display`);
      const bounds = {};
      for (const key of ['start', 'end']) {
        if (!given(obj.display[key])) continue;
        bounds[key] = parseHHMM(obj.display[key]);
        if (bounds[key] === null) fail(`${P}.display.${key}`, `expected HH:MM, got ${show(obj.display[key])}`);
      }
      if (given(bounds.start) && given(bounds.end) && !(bounds.start < bounds.end)) {
        fail(`${P}.display`, 'start must be before end');
      }
    }
    if (given(obj.events)) {
      const ids = new Set();
      needArr(obj.events, `${P}.events`).forEach((e, i) => validateEvent(e, `${P}.events[${i}]`, ids));
    }
    if (given(obj.observations)) textList(obj.observations, `${P}.observations`);
    if (given(obj.watch)) textList(obj.watch, `${P}.watch`);
    if (given(obj.sections)) {
      needArr(obj.sections, `${P}.sections`).forEach((section, i) => {
        const q = `${P}.sections[${i}]`;
        needObj(section, q);
        if (given(section.id)) needText(section.id, `${q}.id`, true);
        needText(section.heading, `${q}.heading`, true);
        textList(section.items, `${q}.items`);
      });
    }
    if (given(obj.story)) {
      needArr(obj.story, `${P}.story`).forEach((para, i) => {
        const q = `${P}.story[${i}]`;
        needObj(para, q);
        needText(para.text, `${q}.text`, true);
        if (!given(para.sources)) return;
        needArr(para.sources, `${q}.sources`).forEach((src, k) => {
          const r = `${q}.sources[${k}]`;
          needObj(src, r);
          needText(src.label, `${r}.label`, true);
          if (given(src.url)) needUrl(src.url, `${r}.url`);
        });
      });
    }
    return obj;
  }

  // ---------------------------------------------------------------- series math

  /** Display window {start, end} in ms: notes.display (KST HH:MM) clipped to the session window, else the session window. */
  function displayWindow(session, notes) {
    const ws = Date.parse(session.window.start);
    const we = Date.parse(session.window.end);
    const display = notes && isObj(notes.display) ? notes.display : null;
    if (!display) return { start: ws, end: we };
    const at = (hhmm) => {
      if (!given(hhmm) || parseHHMM(hhmm) === null || parseDate(session.date) === null) return NaN;
      return Math.min(Math.max(Date.parse(kstToUtcIso(session.date, hhmm)), ws), we);
    };
    const s = at(display.start);
    const e = at(display.end);
    const start = Number.isFinite(s) ? s : ws;
    const end = Number.isFinite(e) ? e : we;
    return start < end ? { start, end } : { start: ws, end: we };
  }

  function pointsOf(series) {
    const raw = series && Array.isArray(series.points) ? series.points : [];
    const out = [];
    for (const pt of raw) {
      let q = null;
      if (Array.isArray(pt)) q = { t: toMs(pt[0]), v: pt[1], p: pt[2] };
      else if (isObj(pt)) q = { t: toMs(pt.t), v: pt.v, p: pt.p };
      if (q && Number.isFinite(q.t) && typeof q.p === 'number' && Number.isFinite(q.p)) out.push(q);
    }
    return out;
  }

  /** Points of a series inside [win.start, win.end] (all points without win) as {t(ms), v, p}. */
  function seriesView(series, win) {
    const pts = pointsOf(series);
    if (!win) return pts;
    const w = normWin(win);
    return pts.filter((q) => q.t >= w.start && q.t <= w.end);
  }

  function statsOf(pts) {
    if (!pts.length) return null;
    let min = pts[0];
    let max = pts[0];
    for (const q of pts) {
      if (q.p < min.p) min = q;
      if (q.p > max.p) max = q;
    }
    const first = pts[0];
    const last = pts[pts.length - 1];
    const recovery = min.p < -0.5 ? (last.p - min.p) / (0 - min.p) : null;
    return { first, last, min, max, recovery, count: pts.length };
  }

  /** First/last/min/max points (earliest on ties), recovery share of the drawdown and point count; null without points. */
  function stats(series, win) {
    return statsOf(seriesView(series, win));
  }

  // Exact point at t, else the latest point within (t - tolMs, t].
  function pickAt(pts, t, tolMs) {
    let best = null;
    for (const q of pts) {
      if (q.t === t) return q;
      if (q.t < t && q.t > t - tolMs && (!best || q.t > best.t)) best = q;
    }
    return best;
  }

  /** Point {t, v, p} at exactly tMs, else the latest point within (tMs - tolerance, tMs], else null. */
  function valueAt(series, tMs, toleranceMin) {
    const tol = (toleranceMin == null ? 15 : toleranceMin) * MINUTE;
    return pickAt(pointsOf(series), toMs(tMs), tol);
  }

  /** Split points into solid 'line' runs, dashed 'gap' connectors (gap <= 125 min) and breaks (longer gaps). */
  function segments(points, gapMinutes) {
    const join = (gapMinutes == null ? 15 : gapMinutes) + 0.5;
    const out = [];
    let line = null;
    let prev = null;
    let prevT = NaN;
    for (const q of points || []) {
      const t = Array.isArray(q) ? toMs(q[0]) : toMs(q && q.t);
      if (!Number.isFinite(t)) continue;
      if (line) {
        const minutes = (t - prevT) / MINUTE;
        if (minutes <= join) {
          line.points.push(q);
          prev = q;
          prevT = t;
          continue;
        }
        if (minutes <= 125) out.push({ kind: 'gap', points: [prev, q] });
      }
      line = { kind: 'line', points: [q] };
      out.push(line);
      prev = q;
      prevT = t;
    }
    return out;
  }

  // ---------------------------------------------------------------- layout

  const TICK_MULTIPLIERS = [1, 2, 2.5, 5];

  /** Nice axis ticks covering [min, max] with a step from {1,2,2.5,5}x10^k, at most maxTicks ticks; decimals = digits the labels need. */
  function niceTicks(min, max, maxTicks) {
    let lo = Number(min);
    let hi = Number(max);
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) throw new TypeError('niceTicks: min and max must be finite numbers');
    if (lo > hi) { const swap = lo; lo = hi; hi = swap; }
    if (lo === hi) { lo -= 0.5; hi += 0.5; }
    // A range that crosses zero needs at least three ticks (-s, 0, s) to be covered.
    const limit = Math.max(lo < 0 && hi > 0 ? 3 : 2, Math.floor(maxTicks == null ? 6 : maxTicks) || 6);
    let k = Math.floor(Math.log10((hi - lo) / limit)) - 1;
    for (let guard = 0; guard < 64; guard += 1, k += 1) {
      for (const m of TICK_MULTIPLIERS) {
        const step = k >= 0 ? m * Math.pow(10, k) : m / Math.pow(10, -k);
        const first = Math.floor(lo / step + 1e-9);
        const last = Math.ceil(hi / step - 1e-9);
        if (last - first + 1 > limit) continue;
        const decimals = Math.max(0, -k + (m === 2.5 ? 1 : 0));
        const ticks = [];
        for (let i = first; i <= last; i += 1) ticks.push(Number((i * step).toFixed(decimals)) || 0);
        return { ticks, step, decimals };
      }
    }
    throw new RangeError('niceTicks: no step found');
  }

  /** Move labels vertically so they keep order, sit >= minGap apart (compressed when they cannot fit) and stay in [top, bottom]. */
  function layoutLabels(items, opts) {
    const o = opts || {};
    const top = Number.isFinite(o.top) ? o.top : -Infinity;
    const bottom = Number.isFinite(o.bottom) ? o.bottom : Infinity;
    const list = [];
    (items || []).forEach((item, i) => {
      const y = item ? Number(item.y) : NaN;
      if (Number.isFinite(y)) list.push({ key: item.key, y, i });
    });
    list.sort((a, b) => a.y - b.y || a.i - b.i);
    const result = new Map();
    if (!list.length) return result;
    let gap = Math.max(0, Number(o.minGap) || 0);
    if (list.length > 1 && (list.length - 1) * gap > bottom - top) gap = Math.max(0, (bottom - top) / (list.length - 1));
    const place = (c) => {
      // Least-squares position of a block of equally spaced labels, clamped to the bounds.
      let sum = 0;
      c.members.forEach((m, j) => { sum += m.y - j * gap; });
      let start = sum / c.members.length;
      start = Math.min(start, bottom - (c.members.length - 1) * gap);
      c.start = Math.max(start, top);
    };
    const clusters = [];
    for (const item of list) {
      const cluster = { members: [item], start: 0 };
      place(cluster);
      clusters.push(cluster);
      while (clusters.length > 1) {
        const cur = clusters[clusters.length - 1];
        const prev = clusters[clusters.length - 2];
        if (prev.start + prev.members.length * gap <= cur.start + 1e-9) break;
        prev.members = prev.members.concat(cur.members);
        clusters.pop();
        place(prev);
      }
    }
    for (const c of clusters) c.members.forEach((m, j) => result.set(m.key, c.start + j * gap));
    return result;
  }

  // ---------------------------------------------------------------- notes helpers

  /** Notes events that fall in (or, for spans such as bands, overlap) the window, sorted by time. */
  function eventsInWindow(notes, win) {
    const list = notes && Array.isArray(notes.events) ? notes.events : [];
    const w = win ? normWin(win) : null;
    const kept = [];
    list.forEach((e, i) => {
      if (!isObj(e)) return;
      const a = toMs(e.at);
      if (!Number.isFinite(a)) return;
      let b = given(e.end) ? toMs(e.end) : a;
      if (!Number.isFinite(b) || b < a) b = a;
      if (w && (b < w.start || a > w.end)) return;
      kept.push({ e, a, i });
    });
    kept.sort((x, y) => x.a - y.a || x.i - y.i);
    return kept.map((x) => x.e);
  }

  const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

  /** HTML-escape text (& < > " '); null/undefined become ''. */
  function escapeHtml(s) {
    return s == null ? '' : String(s).replace(/[&<>"']/g, (c) => ESCAPES[c]);
  }

  /** Escape everything, then turn **bold** into <strong>bold</strong> (the only inline markup). */
  function renderInline(text) {
    return escapeHtml(text).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  }

  // ---------------------------------------------------------------- tables & insights

  const cellOf = (q) => (q ? { p: q.p, v: q.v, t: q.t } : null);

  /** Hour-by-hour table of one panel: hour rows (valueAt), then the 'min' and 'last' rows; cells are {p, v, t} or null. */
  function hourlyTable(session, panelKey, win) {
    const w = win ? normWin(win) : displayWindow(session, null);
    const list = (session && Array.isArray(session.series) ? session.series : []).filter((s) => s && s.panel === panelKey);
    const views = list.map((s) => seriesView(s, w));
    const columns = list.map((s) => ({ id: s.id, label: s.label }));
    const rows = [];
    for (let t = Math.ceil(w.start / HOUR) * HOUR; t <= w.end; t += HOUR) {
      rows.push({ label: kstTime(t), kind: 'hour', t, cells: views.map((pts) => cellOf(pickAt(pts, t, 15 * MINUTE))) });
    }
    const summary = views.map(statsOf);
    rows.push({ label: '최저', kind: 'min', cells: summary.map((st) => (st ? cellOf(st.min) : null)) });
    rows.push({ label: '마지막', kind: 'last', cells: summary.map((st) => (st ? cellOf(st.last) : null)) });
    return { columns, rows };
  }

  function roundInt(x) {
    const n = scaledAbs(x, 0);
    return x < 0 && n ? -n : n;
  }

  // Top and bottom halves (3 each at most) of rows sorted descending by score; never overlapping.
  function topBottom(rows, score) {
    const desc = rows.slice().sort((a, b) => score(b) - score(a));
    const nTop = Math.min(3, Math.ceil(desc.length / 2));
    const nBottom = Math.min(3, desc.length - nTop);
    return { top: desc.slice(0, nTop), bottom: desc.slice(desc.length - nBottom).reverse() };
  }

  /** Automatic factual bullets (Korean, at most 7) about bottoms, rebounds, recovery, drawdowns, laggards and last values. */
  function insights(session, notes, win) {
    if (!session || !Array.isArray(session.series) || !isObj(session.window)) return [];
    const w = win ? normWin(win) : displayWindow(session, notes);
    const stepMs = (Number.isInteger(session.intervalMinutes) && session.intervalMinutes > 0 ? session.intervalMinutes : 15) * MINUTE;
    const anchor = Date.parse(session.window.start);
    const tol = 15 * MINUTE;
    const events = eventsInWindow(notes, w);
    const rows = [];
    for (const s of session.series) {
      const pts = seriesView(s, w);
      if (pts.length) rows.push({ label: String(s.label), pts, st: statsOf(pts) });
    }
    const out = [];
    if (!rows.length) return out;

    // Grid times t (aligned to the session window) such that t - lag and t are both inside the window.
    const gridTimes = (lag) => {
      const times = [];
      let t = anchor + Math.ceil((w.start + lag - anchor) / stepMs) * stepMs;
      for (; t <= w.end; t += stepMs) times.push(t);
      return times;
    };
    // Labels of events whose time (or span) touches [a - 15 min, b + 15 min].
    const nearby = (a, b) => {
      const labels = [];
      for (const e of events) {
        if (typeof e.label !== 'string' || !e.label.trim()) continue;
        const s = toMs(e.at);
        const end = given(e.end) && Number.isFinite(toMs(e.end)) ? Math.max(s, toMs(e.end)) : s;
        if (end >= a - tol && s <= b + tol && labels.indexOf(e.label) < 0) labels.push(e.label);
      }
      return labels;
    };

    // 1. Bottom simultaneity: shortest interval holding >= 60% of the lows of series that fell 0.5% or more.
    let bottom = null;
    const dipped = rows.filter((r) => r.st.min.p <= -0.5);
    if (dipped.length >= 3) {
      const times = dipped.map((r) => r.st.min.t).sort((a, b) => a - b);
      const need = Math.ceil((times.length * 3) / 5);
      let best = 0;
      for (let i = 1; i + need - 1 < times.length; i += 1) {
        if (times[i + need - 1] - times[i] < times[best + need - 1] - times[best]) best = i;
      }
      bottom = { lo: times[best], hi: times[best + need - 1] };
      const k = times.filter((t) => t >= bottom.lo && t <= bottom.hi).length;
      const range = bottom.lo === bottom.hi ? kstTime(bottom.lo) : `${kstTime(bottom.lo)}–${kstTime(bottom.hi)}`;
      const labels = nearby(bottom.lo, bottom.hi);
      out.push({ kind: 'bottom',
        text: `바닥 시각: ${k}/${times.length}개 계열이 ${range}에 최저점${labels.length ? ` (이 구간 사건: ${labels.join(', ')})` : ''}` });
    }

    // 2. Steepest joint rebound: the grid time with the highest mean 30-minute change (needs >= 5 series).
    let rebound = null;
    for (const t of gridTimes(30 * MINUTE)) {
      let sum = 0;
      let count = 0;
      for (const r of rows) {
        const a = pickAt(r.pts, t, tol);
        const b = pickAt(r.pts, t - 30 * MINUTE, tol);
        if (a && b) { sum += a.p - b.p; count += 1; }
      }
      if (count >= 5 && (!rebound || sum / count > rebound.mean + 1e-12)) rebound = { t, mean: sum / count };
    }
    if (rebound && rebound.mean > 0 && scaledAbs(rebound.mean, 1) > 0) {
      const from = rebound.t - 30 * MINUTE;
      const labels = nearby(from, rebound.t);
      out.push({ kind: 'rebound',
        text: `가장 가파른 동반 반등: ${kstTime(from)}–${kstTime(rebound.t)} (평균 ${formatSignedPp(rebound.mean)}${labels.length ? ` · 이 구간 사건: ${labels.join(', ')}` : ''})` });
    }

    // 3. Drawdown recovery (series that fell 1% or more): top and bottom by recovered share.
    const recovering = rows.filter((r) => r.st.recovery !== null && r.st.min.p <= -1);
    if (recovering.length >= 2) {
      const { top, bottom: low } = topBottom(recovering, (r) => r.st.recovery);
      const item = (r) => `${r.label} ${roundInt(r.st.recovery * 100)}%`;
      out.push({ kind: 'recovery', text: `낙폭 회복률 상위: ${top.map(item).join(' · ')} / 하위: ${low.map(item).join(' · ')}` });
    }

    // 4. Deepest drawdowns: the three lowest minima.
    const deepest = rows.filter((r) => r.st.min.p < 0 && scaledAbs(r.st.min.p, 1) > 0)
      .sort((a, b) => a.st.min.p - b.st.min.p).slice(0, 3);
    if (deepest.length) {
      out.push({ kind: 'drawdown',
        text: `가장 깊은 낙폭: ${deepest.map((r) => `${r.label} ${formatPct(r.st.min.p)}(${kstTime(r.st.min.t)})`).join(' · ')}` });
    }

    // 5. Resilient series: barely below the baseline and ending clearly above it.
    const firm = rows.filter((r) => r.st.min.p >= -0.6 && r.st.last.p >= 0.5);
    if (firm.length) {
      out.push({ kind: 'resilient',
        text: `기준선 아래로 거의 내려가지 않은 계열: ${firm.map((r) => `${r.label}(최저 ${formatPct(r.st.min.p)})`).join(' · ')}` });
    }

    // 6. Late movers: largest 60-minute move (>= 1.0p) starting 45+ minutes after the bottom interval.
    if (bottom) {
      const after = bottom.hi + 45 * MINUTE;
      const late = [];
      for (const r of rows) {
        let move = null;
        for (const t of gridTimes(HOUR)) {
          const a = pickAt(r.pts, t, tol);
          const b = pickAt(r.pts, t - HOUR, tol);
          if (!a || !b) continue;
          const d = a.p - b.p;
          if (!move || Math.abs(d) > Math.abs(move.d) + 1e-12) move = { d, from: t - HOUR };
        }
        if (move && Math.abs(move.d) >= 1 - 1e-9 && move.from >= after) late.push({ r, move });
      }
      if (late.length) {
        // Keep the three latest moves (larger move first on equal start), then list them chronologically.
        late.sort((a, b) => b.move.from - a.move.from || Math.abs(b.move.d) - Math.abs(a.move.d));
        const chosen = late.slice(0, 3).sort((a, b) => a.move.from - b.move.from);
        const items = chosen.map((x) => `${x.r.label}: ${kstTime(x.move.from)} 이후 ${formatSignedPp(x.move.d)}`);
        out.push({ kind: 'late', text: `${items.join(' · ')} (다른 자산 반등 이후 움직임)` });
      }
    }

    // 7. Last values: top and bottom three.
    if (rows.length >= 2) {
      const { top, bottom: low } = topBottom(rows, (r) => r.st.last.p);
      const item = (r) => `${r.label} ${formatPct(r.st.last.p)}`;
      out.push({ kind: 'last', text: `마지막 값 상위: ${top.map(item).join(' · ')} / 하위: ${low.map(item).join(' · ')}` });
    }
    return out.slice(0, 7);
  }

  return {
    PANELS, SERIES, COLORS, PROVIDERS, KST_OFFSET_MS, STATUSES, EVENT_KINDS,
    kstDate, kstTime, kstToUtcIso, sessionWindow, toMs, isoUtc,
    formatPct, formatSignedPp, formatValue, pctChange,
    validateIndex, validateSession, validateNotes,
    displayWindow, seriesView, stats, valueAt, segments,
    niceTicks, layoutLabels,
    insights, hourlyTable, eventsInWindow, renderInline, escapeHtml,
  };
});
