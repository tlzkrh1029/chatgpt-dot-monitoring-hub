/* Independent parallel-chart data contract. Existing publisher contracts are untouched.
 * CSV imports stay local references: neither evidence nor permission to redistribute.
 */
(function (root, factory) {
  'use strict';
  const api = factory(typeof module === 'object' && module.exports
    ? require('./public-data.js') : root.MonitorData);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ParallelData = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (publicContract) {
  'use strict';
  const MINUTE = 60000;
  const PANELS = Object.freeze([
    Object.freeze({ key: 'indices', label: '주식지수' }),
    Object.freeze({ key: 'ai', label: 'AI·반도체 종목' }),
    Object.freeze({ key: 'crypto', label: '크립토' }),
    Object.freeze({ key: 'fx', label: '달러·금' })
  ]);
  const PANEL_KEYS = PANELS.map(panel => panel.key);
  const clone = value => JSON.parse(JSON.stringify(value));
  const fail = (path, message) => { throw new Error(`${path}: ${message}`); };
  const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  function object(value, path, fields) {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(path, 'expected a plain object');
    for (const key of Object.keys(value)) if (!fields.includes(key)) fail(path, 'unrecognized field');
    for (const key of fields) if (!own(value, key)) fail(`${path}.${key}`, 'required field missing');
  }
  function text(value, path, maximum = 200, allowEmpty = false) {
    if (typeof value !== 'string' || value.length > maximum || (!allowEmpty && !value.trim())) fail(path, 'expected bounded plain text');
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value) ||
      /(?:[a-z][a-z0-9+.-]*:\/\/|www\.)/i.test(value) ||
      /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(value) ||
      /(?:\b(?:sk-|gh[pousr]_|github_pat_)[A-Za-z0-9_-]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:api[_ -]?key|access[_ -]?token|password|secret)\s*[:=]\s*\S+)/i.test(value)) {
      fail(path, 'links, contacts, credentials or control characters are not allowed in prose');
    }
  }
  function list(value, path, maximum) {
    if (!Array.isArray(value) || value.length > maximum) fail(path, 'expected a bounded array');
  }
  function choice(value, path, options) {
    if (!options.includes(value)) fail(path, 'unsupported value');
  }
  function timestamp(value, path, maximum = Infinity) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value)) fail(path, 'expected a UTC ISO timestamp');
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 19) !== value.slice(0, 19)) fail(path, 'invalid timestamp');
    if (parsed > maximum) fail(path, 'timestamp is in the future');
    return parsed;
  }
  function nullableDate(value, path, maximum) {
    return value === null ? null : timestamp(value, path, maximum);
  }
  function nullableSource(value, path) {
    if (value !== null) publicContract.publicUrl(value, path);
  }
  function unique(value, set, path) {
    text(value, path, 120);
    if (set.has(value)) fail(path, 'duplicate identifier');
    set.add(value);
  }

  function validateDataset(raw, { allowLocalReference = false, now = Date.now() } = {}) {
    const current = Number(new Date(now));
    if (!Number.isFinite(current)) fail('now', 'invalid clock');
    const maximum = current + 5 * MINUTE;
    object(raw, 'dataset', ['schemaVersion', 'mode', 'title', 'publishedAt', 'window', 'series', 'events', 'stories']);
    if (raw.schemaVersion !== 1) fail('dataset.schemaVersion', 'unsupported schema version');
    choice(raw.mode, 'dataset.mode', ['reference', 'observed']);
    text(raw.title, 'dataset.title');
    const publication = nullableDate(raw.publishedAt, 'dataset.publishedAt', maximum);
    object(raw.window, 'dataset.window', ['start', 'end', 'timezone', 'intervalMinutes']);
    const start = timestamp(raw.window.start, 'dataset.window.start');
    const end = timestamp(raw.window.end, 'dataset.window.end');
    if (end <= start || end - start > 7 * 24 * 60 * MINUTE) fail('dataset.window', 'expected a positive window of at most seven days');
    if (raw.window.timezone !== 'Asia/Seoul' || raw.window.intervalMinutes !== 15) fail('dataset.window', 'expected a 15-minute Asia/Seoul window');
    list(raw.series, 'dataset.series', 128);
    list(raw.events, 'dataset.events', 200);
    list(raw.stories, 'dataset.stories', 100);
    const seriesIds = new Set();
    raw.series.forEach((series, index) => {
      const path = `dataset.series[${index}]`;
      object(series, path, ['id', 'panel', 'label', 'instrument', 'basis', 'provider', 'sourceUrl', 'verification', 'redistribution', 'availability', 'asOf', 'observedAt', 'delaySeconds', 'marketState', 'points']);
      unique(series.id, seriesIds, `${path}.id`);
      choice(series.panel, `${path}.panel`, PANEL_KEYS);
      for (const key of ['label', 'instrument', 'basis', 'provider']) text(series[key], `${path}.${key}`);
      nullableSource(series.sourceUrl, `${path}.sourceUrl`);
      choice(series.verification, `${path}.verification`, ['unverified', 'verified']);
      choice(series.redistribution, `${path}.redistribution`, ['unverified', 'permitted']);
      choice(series.availability, `${path}.availability`, ['unsupported', 'delayed', 'available']);
      choice(series.marketState, `${path}.marketState`, ['unknown', 'open', 'closed']);
      const asOf = nullableDate(series.asOf, `${path}.asOf`, maximum);
      const observed = nullableDate(series.observedAt, `${path}.observedAt`, maximum);
      if (series.delaySeconds !== null && (typeof series.delaySeconds !== 'number' || !Number.isFinite(series.delaySeconds) || series.delaySeconds < 0)) fail(`${path}.delaySeconds`, 'expected a nonnegative delay or null');
      if (asOf !== null && observed !== null && asOf > observed) fail(path, 'source time is newer than the observation');
      if (observed !== null && publication !== null && observed > publication) fail(path, 'observation is newer than publication');
      list(series.points, `${path}.points`, 5000);
      let previous = -Infinity;
      series.points.forEach((point, pointIndex) => {
        const pointPath = `${path}.points[${pointIndex}]`;
        object(point, pointPath, ['at', 'pct']);
        const at = timestamp(point.at, `${pointPath}.at`, maximum);
        if (at < start || at > end || at <= previous) fail(pointPath, 'points must be unique, ordered and inside the window');
        if (typeof point.pct !== 'number' || !Number.isFinite(point.pct)) fail(`${pointPath}.pct`, 'expected a finite percentage');
        previous = at;
      });
      if (series.points.length) {
        if (asOf !== previous) fail(`${path}.asOf`, 'must equal the final source point time');
        if (raw.mode === 'reference') {
          if (!allowLocalReference) fail(path, 'reference values are local only');
          if (series.verification !== 'unverified' || series.redistribution !== 'unverified') fail(path, 'reference values cannot claim verification or redistribution permission');
        } else if (series.verification !== 'verified' || series.redistribution !== 'permitted' ||
          !series.sourceUrl || observed === null || publication === null) {
          fail(path, 'observed values require verified evidence, redistribution permission and source clocks');
        }
      } else if (series.asOf !== null) fail(`${path}.asOf`, 'must be null when no source points exist');
    });
    const eventIds = new Set();
    raw.events.forEach((event, index) => {
      const path = `dataset.events[${index}]`;
      object(event, path, ['id', 'at', 'label', 'type', 'verification', 'sourceUrl', 'observedAt']);
      unique(event.id, eventIds, `${path}.id`);
      const at = timestamp(event.at, `${path}.at`, maximum);
      if (at < start || at > end) fail(`${path}.at`, 'event is outside the window');
      text(event.label, `${path}.label`);
      choice(event.type, `${path}.type`, ['prediction', 'media_call', 'official_certification', 'statement', 'concession']);
      choice(event.verification, `${path}.verification`, ['unverified', 'verified']);
      nullableSource(event.sourceUrl, `${path}.sourceUrl`);
      const observed = nullableDate(event.observedAt, `${path}.observedAt`, maximum);
      if (observed !== null && (at > observed || (publication !== null && observed > publication))) fail(path, 'invalid event observation chronology');
      if (raw.mode === 'reference') {
        if (!allowLocalReference) fail(path, 'reference events are local only');
        if (event.verification !== 'unverified') fail(path, 'reference event cannot claim verification');
      }
      if (event.verification === 'verified' && (!event.sourceUrl || observed === null || publication === null)) fail(path, 'verified events require a source and observation/publication clocks');
    });
    raw.stories.forEach((story, index) => {
      const path = `dataset.stories[${index}]`;
      object(story, path, ['at', 'title', 'story', 'sources', 'interpretation', 'verdict', 'nextWatch']);
      const at = timestamp(story.at, `${path}.at`, maximum);
      if (publication !== null && at > publication) fail(`${path}.at`, 'story is newer than publication');
      text(story.title, `${path}.title`);
      for (const key of ['story', 'interpretation', 'verdict', 'nextWatch']) text(story[key], `${path}.${key}`, 8000);
      list(story.sources, `${path}.sources`, 8);
      story.sources.forEach((url, sourceIndex) => publicContract.publicUrl(url, `${path}.sources[${sourceIndex}]`));
    });
    return clone(raw);
  }

  // Empty cells are gaps, not zeroes. Quoted CSV fields and CRLF/BOM are supported.
  function readCsv(source, fields) {
    if (typeof source !== 'string' || source.length > 2000000) fail('csv', 'expected a CSV document below two million characters');
    source = source.replace(/^\uFEFF/, '');
    const rows = [];
    let row = [], cell = '', quoted = false, afterQuote = false;
    function finishCell() { row.push(cell); cell = ''; afterQuote = false; }
    function finishRow() {
      finishCell();
      if (row.some(value => value.trim())) rows.push(row);
      row = [];
    }
    for (let index = 0; index < source.length; index++) {
      const char = source[index];
      if (quoted) {
        if (char === '"') {
          if (source[index + 1] === '"') { cell += '"'; index++; }
          else { quoted = false; afterQuote = true; }
        } else cell += char;
      } else if (char === ',') finishCell();
      else if (char === '\n' || char === '\r') {
        if (char === '\r' && source[index + 1] === '\n') index++;
        finishRow();
      } else if (char === '"') {
        if (cell || afterQuote) fail('csv', 'unexpected quote');
        quoted = true;
      } else {
        if (afterQuote) fail('csv', 'unexpected text after quote');
        cell += char;
      }
    }
    if (quoted) fail('csv', 'unterminated quote');
    if (cell || row.length || afterQuote) finishRow();
    if (!rows.length || rows[0].length !== fields.length || rows[0].some((field, i) => field !== fields[i])) fail('csv', 'unexpected CSV columns');
    if (rows.length > 20001) fail('csv', 'too many rows');
    return rows.slice(1).map(row => {
      if (row.length !== fields.length) fail('csv', 'unexpected cell count');
      return Object.fromEntries(fields.map((field, index) => [field, row[index].trim()]));
    });
  }
  function referenceTime(value) {
    if (!/^\d{2}:\d{2}$/.test(value)) fail('csv.time_kst', 'expected HH:mm');
    const hour = Number(value.slice(0, 2)), minute = Number(value.slice(3));
    if (hour > 23 || minute > 59) fail('csv.time_kst', 'invalid clock');
    return new Date(Date.UTC(2026, 10, 4, hour - 9, minute)).toISOString();
  }
  function parseReference(pricesCsv, eventsCsv) {
    const prices = readCsv(pricesCsv, ['panel', 'series', 'time_kst', 'pct']);
    const eventRows = readCsv(eventsCsv, ['time_kst', 'event', 'type']);
    const panelMap = new Map(PANELS.map(panel => [panel.label, panel.key]));
    const map = new Map();
    for (const row of prices) {
      if (!panelMap.has(row.panel)) fail('csv.panel', 'unknown panel');
      text(row.series, 'csv.series');
      const panel = panelMap.get(row.panel);
      const key = `${panel}:${row.series}`;
      if (!map.has(key)) {
        const fromEight = ['crypto', 'fx'].includes(panel) || /나스닥.*선물/.test(row.series);
        map.set(key, { id: `reference-${map.size + 1}`, panel, label: row.series, instrument: `${row.series} · 식별자 미검증`,
          basis: fromEight ? '08:00 KST 대비 · 기준 미검증' : '전일 종가 대비 · 거래일·기준 미검증',
          provider: '미검증 역사적 참조', sourceUrl: null, verification: 'unverified', redistribution: 'unverified',
          availability: 'unsupported', asOf: null, observedAt: null, delaySeconds: null, marketState: 'unknown', points: [] });
      }
      const at = referenceTime(row.time_kst);
      // A blank explicitly reserves a missing time; it never creates a fake observation.
      if (!row.pct) continue;
      if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(row.pct)) fail('csv.pct', 'expected a numeric percentage or blank');
      const pct = Number(row.pct);
      if (!Number.isFinite(pct)) fail('csv.pct', 'expected a finite percentage');
      map.get(key).points.push({ at, pct });
    }
    const series = [...map.values()].sort((a, b) => PANEL_KEYS.indexOf(a.panel) - PANEL_KEYS.indexOf(b.panel));
    series.forEach(item => {
      item.points.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
      item.asOf = item.points.at(-1)?.at || null;
    });
    const events = eventRows.map((row, index) => {
      text(row.event, 'csv.event'); text(row.type, 'csv.type');
      const type = /승복/.test(row.type) ? 'concession' : /발언|인터뷰|수용|축하/.test(`${row.event} ${row.type}`) ? 'statement' : 'media_call';
      return { id: `reference-event-${index + 1}`, at: referenceTime(row.time_kst), label: `${row.event} · ${row.type}`,
        type, verification: 'unverified', sourceUrl: null, observedAt: null };
    });
    return validateDataset({ schemaVersion: 1, mode: 'reference', title: 'Discord 역사적 참조 · 독립 검증 전', publishedAt: null,
      window: { start: '2026-11-03T23:00:00.000Z', end: '2026-11-04T06:00:00.000Z', timezone: 'Asia/Seoul', intervalMinutes: 15 },
      series, events, stories: [] }, { allowLocalReference: true });
  }

  function segments(points, intervalMinutes = 15) {
    if (!Number.isFinite(intervalMinutes) || intervalMinutes <= 0) fail('intervalMinutes', 'expected a positive interval');
    const result = [];
    for (const point of points) {
      const group = result.at(-1);
      if (!group || Date.parse(point.at) - Date.parse(group.at(-1).at) > intervalMinutes * MINUTE) result.push([point]);
      else group.push(point);
    }
    return result;
  }
  function summarizeSeries(series, window) {
    const points = series.points;
    if (!points.length) return { firstAt: null, lastAt: null, pointCount: 0, expectedGridCount: 0, missingGridCount: 0, offGridCount: 0, gaps: [] };
    const step = window.intervalMinutes * MINUTE;
    const origin = Date.parse(window.start);
    const first = Date.parse(points[0].at), last = Date.parse(points.at(-1).at);
    const grid = new Set(points.map(point => Date.parse(point.at)));
    let expectedGridCount = 0, missingGridCount = 0;
    for (let at = origin + Math.ceil((first - origin) / step) * step; at <= last; at += step) {
      expectedGridCount++;
      if (!grid.has(at)) missingGridCount++;
    }
    const gaps = [];
    for (let index = 1; index < points.length; index++) {
      if (Date.parse(points[index].at) - Date.parse(points[index - 1].at) > step) gaps.push({ start: points[index - 1].at, end: points[index].at });
    }
    return { firstAt: points[0].at, lastAt: points.at(-1).at, pointCount: points.length, expectedGridCount, missingGridCount,
      offGridCount: points.filter(point => (Date.parse(point.at) - origin) % step !== 0).length, gaps };
  }
  return Object.freeze({ PANELS, validateDataset, parseReference, segments, summarizeSeries });
});
