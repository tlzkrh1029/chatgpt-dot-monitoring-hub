'use strict';
// Collector (scripts/collect-parallel.js) and validator (scripts/validate-parallel.js) tests.
// No network: provider responses come from tests/fixtures/parallel (small synthetic files for the
// 2026-03-04 KST session) or from inline charts and injected transports.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const Core = require('../parallel-core.js');
const C = require('../scripts/collect-parallel.js');
const { validateDataDir } = require('../scripts/validate-parallel.js');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(__dirname, 'fixtures', 'parallel');
const SCRIPT = path.join(ROOT, 'scripts', 'collect-parallel.js');
const VALIDATOR = path.join(ROOT, 'scripts', 'validate-parallel.js');
const DATE = '2026-03-04'; // Wednesday; window 2026-03-03T23:00Z .. 2026-03-04T07:00Z
const WIN = Core.sessionWindow(DATE);
const FINAL_NOW = '2026-03-04T07:30:00Z'; // 16:30 KST: final
const ms = (iso) => Date.parse(iso);
const sec = (iso) => Date.parse(iso) / 1000;
const kst = (hhmm, date = DATE) => Core.kstToUtcIso(date, hhmm);
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(FIX, name), 'utf8'));
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-collector-'));
const quiet = () => {};
const noSleep = async () => {};
const view = (points) => points.map((p) => [Core.kstTime(p.t), p.v]);
const byId = (session) => Object.fromEntries(session.series.map((s) => [s.id, s]));
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

/** Yahoo chart JSON from [[isoStart, open, close], ...] and day periods [[[isoStart, isoEnd], ...], ...]. */
function yahooJson({ bars, periods = [], rmt = null, cpc = null, gmtoffset = 0 }) {
  const meta = { gmtoffset, tradingPeriods: periods.map((day) => day.map(([a, b]) => ({ start: sec(a), end: sec(b) }))) };
  if (rmt) meta.regularMarketTime = sec(rmt);
  if (cpc) meta.chartPreviousClose = cpc;
  return { chart: { result: [{ meta, timestamp: bars.map((b) => sec(b[0])),
    indicators: { quote: [{ open: bars.map((b) => b[1]), close: bars.map((b) => b[2]) }] } }], error: null } };
}
const chartOf = (spec) => C.parseYahooChart(yahooJson(spec));

/** Fixture transport that answers every Yahoo intraday request lacking a fixture with a generic 24h chart. */
function completeTransport() {
  const fixtures = C.fixtureTransport(FIX);
  const generic = fs.readFileSync(path.join(FIX, 'HYPE32196-USD.intraday.json'), 'utf8');
  return async (url) => {
    const res = await fixtures(url);
    return res.status === 404 && url.includes('interval=15m') ? { status: 200, text: generic } : res;
  };
}

/** Value of a raw fixture bar (cleaned like the collector does). */
function barValue(file, field, hhmm, date = DATE) {
  const r = fixture(file).chart.result[0];
  const i = r.timestamp.indexOf(sec(kst(hhmm, date)));
  assert.ok(i >= 0, `${file} has a bar at ${hhmm} KST`);
  return C.cleanPrice(r.indicators.quote[0][field][i]);
}

// ---------------------------------------------------------------- pure helpers

test('serializeJson: 2-space indentation, one line per point, same data as JSON.stringify', () => {
  const obj = { a: 1, b: [], c: {}, s: { points: [['2026-03-04T00:00:00Z', 1.5, -0.25], ['2026-03-04T00:15:00Z', 2, 0]] },
    list: [{ x: null, t: 'é' }], skip: undefined };
  const text = C.serializeJson(obj);
  assert.equal(text, '{\n  "a": 1,\n  "b": [],\n  "c": {},\n  "s": {\n    "points": [\n'
    + '      ["2026-03-04T00:00:00Z", 1.5, -0.25],\n      ["2026-03-04T00:15:00Z", 2, 0]\n    ]\n  },\n'
    + '  "list": [\n    {\n      "x": null,\n      "t": "é"\n    }\n  ]\n}\n');
  assert.deepEqual(JSON.parse(text), JSON.parse(JSON.stringify(obj)));
});

test('cleanPrice recovers float32 decimals, parses decimal strings and rejects non-positive values', () => {
  assert.equal(C.cleanPrice(5786.1298828125), 5786.13);
  assert.equal(C.cleanPrice(Math.fround(101.885)), 101.885);
  assert.equal(C.cleanPrice(63081.859375), 63081.86);
  assert.equal(C.cleanPrice(1398000), 1398000);
  assert.equal(C.cleanPrice('77806.58'), 77806.58);
  assert.equal(C.cleanPrice('1286.28356982762'), 1286.28357);
  for (const bad of [null, undefined, 0, -1, NaN, Infinity, '', 'abc', {}]) assert.equal(C.cleanPrice(bad), null);
  assert.equal(C.sanitizeSymbol('^KS11'), '_KS11');
  assert.equal(C.sanitizeSymbol('NQ=F'), 'NQ_F');
  assert.equal(C.sanitizeSymbol('DX-Y.NYB'), 'DX-Y.NYB');
});

test('parseYahooChart normalizes bars, trading periods and meta, and rejects unusable responses', () => {
  const chart = C.parseYahooChart(fixture('_KS11.intraday.json'));
  assert.equal(chart.bars.length, 25);
  assert.deepEqual(chart.bars[0], { ts: sec(kst('09:00')), open: 2510.2, close: 2514.6 });
  assert.deepEqual(chart.bars[6], { ts: sec(kst('10:30')), open: null, close: null });
  assert.deepEqual(chart.periods, [{ start: sec(kst('09:00')), end: sec(kst('15:00')), lastOfDay: true }]);
  assert.equal(chart.gmtoffset, 32400);
  assert.equal(chart.chartPreviousClose, 2500.5);
  assert.equal(chart.regularMarketTime, sec(kst('15:30')));

  // A day split into two periods: only the afternoon period closes the day. The includePrePost shape is accepted.
  const split = [[{ start: sec(kst('09:00')), end: sec(kst('11:30')) }, { start: sec(kst('12:30')), end: sec(kst('15:30')) }]];
  assert.deepEqual(C.tradingPeriods(split).map((p) => p.lastOfDay), [false, true]);
  assert.equal(C.tradingPeriods({ regular: split }).length, 2);
  assert.deepEqual(C.tradingPeriods(undefined), []);

  // Holiday: Yahoo answers without timestamps.
  const holiday = C.parseYahooChart({ chart: { result: [{ meta: { gmtoffset: 32400 }, indicators: { quote: [{}] } }], error: null } });
  assert.deepEqual(holiday.bars, []);

  assert.throws(() => C.parseYahooChart({ chart: { result: null, error: { code: 'Not Found' } } }), /Not Found/);
  assert.throws(() => C.parseYahooChart({}), /no chart/);
  assert.throws(() => C.parseYahooChart({ chart: { result: [{ timestamp: [1, 2], indicators: { quote: [{ close: [1] }] } }] } }), /does not match/);
});

test('yahooPoints: run starts use the open, bars end at their close, the KOSPI closing print is plotted at 15:30 KST', () => {
  const chart = C.parseYahooChart(fixture('_KS11.intraday.json'));
  const points = C.yahooPoints(chart, { window: WIN, nowMs: ms(FINAL_NOW), closeKst: '15:30' });
  const v = view(points);
  assert.deepEqual(v.slice(0, 2), [['09:00', 2510.2], ['09:15', 2514.6]]);
  // The 10:30 bar is empty: the 10:15 bar ends at 10:30 and the next run reopens with the 10:45 open.
  assert.deepEqual(v.filter(([t]) => t >= '10:30' && t <= '11:00'), [['10:30', 2481.5], ['10:45', 2479.8], ['11:00', 2475.2]]);
  // Yahoo's KOSPI period ends at 15:00; that bar is the official 15:30 close.
  assert.deepEqual(v.slice(-2), [['15:00', 2519.3], ['15:30', 2523.6]]);
  assert.equal(points.length, 26);
  assert.ok(points.every((p, i) => i === 0 || p.t > points[i - 1].t));
});

test('yahooPoints: before the official close the print bar is an ordinary in-progress bar capped at now', () => {
  const chart = C.parseYahooChart(fixture('_KS11.intraday.json'));
  const points = C.yahooPoints(chart, { window: WIN, nowMs: ms(kst('15:10')), closeKst: '15:30' });
  assert.deepEqual(view(points).slice(-2), [['15:00', 2519.3], ['15:10', 2523.6]]);
  // Mid-session: bars after min(end, now) + 60 s are outside the requested range.
  const early = C.yahooPoints(chart, { window: WIN, nowMs: ms(kst('11:07')) + 30e3, closeKst: '15:30' });
  assert.equal(early[early.length - 1].t, ms(kst('11:07')) + 30e3);
  assert.equal(early[early.length - 1].v, barValue('_KS11.intraday.json', 'close', '11:00'));
});

test('yahooPoints: a print bar stamped at the period end replaces the previous bar end (TAIEX 14:30)', () => {
  const chart = chartOf({ periods: [[[kst('10:00'), kst('14:30')]]], gmtoffset: 28800,
    bars: [[kst('14:00'), 100, 101], [kst('14:15'), 101, 102], [kst('14:30'), 101.5, 101.5]] });
  const points = C.yahooPoints(chart, { window: WIN, nowMs: ms(FINAL_NOW), closeKst: '14:30' });
  assert.deepEqual(view(points), [['14:00', 100], ['14:15', 101], ['14:30', 101.5]]);
});

test('yahooPoints: the Nikkei lunch gap reopens with the afternoon open and ends with the 15:30 print', () => {
  const file = '_N225.intraday.json';
  const chart = C.parseYahooChart(fixture(file));
  const v = view(C.yahooPoints(chart, { window: WIN, nowMs: ms(FINAL_NOW), closeKst: '15:30' }));
  const close = (h) => barValue(file, 'close', h);
  const open = (h) => barValue(file, 'open', h);
  assert.deepEqual(v.filter(([t]) => t >= '11:30' && t <= '12:45'),
    [['11:30', close('11:15')], ['11:45', close('11:30')], ['12:30', open('12:30')], ['12:45', close('12:30')]]);
  assert.deepEqual(v[v.length - 1], ['15:30', close('15:30')]);
  assert.equal(v.length, 25);
});

test('yahooPoints: a 24h period boundary (23:59 end, 00:00 start) is not mistaken for a closing print', () => {
  const file = 'HYPE32196-USD.intraday.json';
  const chart = C.parseYahooChart(fixture(file));
  const v = view(C.yahooPoints(chart, { window: WIN, nowMs: ms(FINAL_NOW) }));
  const close = (h) => barValue(file, 'close', h);
  assert.ok(!v.some(([t]) => t === '08:59'));
  assert.deepEqual(v.filter(([t]) => t >= '08:45' && t <= '09:15'), [['08:45', close('08:30')], ['09:00', close('08:45')], ['09:15', close('09:00')]]);
  assert.equal(v[0][0], '08:00');
  assert.equal(v[v.length - 1][0], '16:00');
  assert.equal(v.length, 33);
});

test('yahooPoints: a live tick and the bar holding regularMarketTime collapse into one point at that time', () => {
  const periods = [[['2026-03-04T00:00:00Z', '2026-03-04T23:59:00Z']]];
  const bars = [['2026-03-04T01:45:00Z', 9.5, 10], ['2026-03-04T02:00:00Z', 10, 11], ['2026-03-04T02:15:00Z', 11, 12],
    ['2026-03-04T02:21:13Z', 11.5, 11.5]];
  const chart = chartOf({ periods, bars, rmt: '2026-03-04T02:21:13Z' });
  const points = C.yahooPoints(chart, { window: WIN, nowMs: ms('2026-03-04T02:22:00Z') });
  assert.deepEqual(points.map((p) => [Core.isoUtc(p.t), p.v]), [
    ['2026-03-04T01:45:00Z', 9.5], ['2026-03-04T02:00:00Z', 10], ['2026-03-04T02:15:00Z', 11], ['2026-03-04T02:21:13Z', 11.5]]);
  // Without a tick, the in-progress bar ends at now; a stale regularMarketTime never moves it before the bar start.
  const stale = chartOf({ periods, bars: bars.slice(0, 3), rmt: '2026-03-04T01:00:00Z' });
  const last = C.yahooPoints(stale, { window: WIN, nowMs: ms('2026-03-04T02:22:00Z') }).pop();
  assert.deepEqual([Core.isoUtc(last.t), last.v], ['2026-03-04T02:22:00Z', 12]);
});

test('yahooBaseline (window start): 08:00 close, else the 08:00 open, else the first value within 30 minutes', () => {
  const now = ms(FINAL_NOW);
  const hype = C.parseYahooChart(fixture('HYPE32196-USD.intraday.json'));
  assert.deepEqual(C.yahooBaseline(hype, { basis: 'windowStart', window: WIN, points: C.yahooPoints(hype, { window: WIN, nowMs: now }) }),
    { value: barValue('HYPE32196-USD.intraday.json', 'close', '07:45'), label: '08:00 KST' });
  // CME break: the 07:45 bar is empty, so the 08:00 bar's open is the value at 08:00.
  const nq = C.parseYahooChart(fixture('NQ_F.intraday.json'));
  assert.deepEqual(C.yahooBaseline(nq, { basis: 'windowStart', window: WIN, points: C.yahooPoints(nq, { window: WIN, nowMs: now }) }),
    { value: 20000.25, label: '08:00 KST 시가' });
  const late = chartOf({ bars: [[kst('08:15'), 50, 51], [kst('08:30'), 51, 52]] });
  assert.deepEqual(C.yahooBaseline(late, { basis: 'windowStart', window: WIN, points: C.yahooPoints(late, { window: WIN, nowMs: now }) }),
    { value: 50, label: '첫 관측 08:15 KST' });
  const tooLate = chartOf({ bars: [[kst('08:45'), 50, 51]] });
  assert.equal(C.yahooBaseline(tooLate, { basis: 'windowStart', window: WIN, points: C.yahooPoints(tooLate, { window: WIN, nowMs: now }) }), null);
});

test('yahooBaseline (previous close): last daily close before the session date, else meta.chartPreviousClose', () => {
  const intraday = C.parseYahooChart(fixture('_KS11.intraday.json'));
  const daily = C.parseYahooChart(fixture('_KS11.daily.json'));
  assert.deepEqual(C.yahooBaseline(intraday, { basis: 'prevClose', window: WIN, date: DATE, daily }), { value: 2500.5, label: '3/3 종가' });
  // Tokyo holiday on 11/3: the previous close is 11/2's, by the exchange-local date of the daily bar.
  const tokyo = chartOf({ gmtoffset: 32400, bars: [['2026-11-02T00:00:00Z', 1, 63081.859375], ['2026-11-04T00:00:00Z', 1, 62188.62890625]] });
  assert.deepEqual(C.dailyPrevClose(tokyo, '2026-11-04'), { value: 63081.86, label: '11/2 종가' });
  assert.deepEqual(C.yahooBaseline(C.parseYahooChart(fixture('_N225.intraday.json')), { basis: 'prevClose', window: WIN, daily: null }),
    { value: 38000, label: C.LABEL_PREV_CLOSE_FALLBACK });
  assert.equal(C.yahooBaseline(chartOf({ bars: [] }), { basis: 'prevClose', window: WIN, daily: null }), null);
});

test('coinMetricsSeries samples 15-minute marks inside the window, adds the newest row as a live tick, finds the baseline', () => {
  const rows = fixture('coinmetrics.json');
  const value = (asset, iso) => C.cleanPrice(rows.data.find((r) => r.asset === asset && r.time.startsWith(iso)).ReferenceRateUSD);
  const final = C.coinMetricsSeries(rows, { window: WIN, nowMs: ms(FINAL_NOW) });
  assert.deepEqual(Object.keys(final).sort(), ['btc', 'eth', 'zec']);
  assert.deepEqual(final.btc.baseline, { value: value('btc', '2026-03-03T23:00'), label: '08:00 KST' });
  assert.equal(final.btc.points.length, 33);
  assert.ok(final.btc.points.every((p) => p.t % 900000 === 0 && p.t >= ms(WIN.start) && p.t <= ms(WIN.end)));
  assert.deepEqual(final.zec.baseline, { value: 410, label: '첫 관측 08:20 KST' });
  assert.equal(Core.kstTime(final.zec.points[0].t), '08:30');

  const live = C.coinMetricsSeries(rows.data, { window: WIN, nowMs: ms('2026-03-04T02:07:30Z') });
  const last = live.btc.points[live.btc.points.length - 1];
  assert.deepEqual([Core.isoUtc(last.t), last.v], ['2026-03-04T02:03:00Z', value('btc', '2026-03-04T02:03')]);
  assert.equal(live.eth.points[live.eth.points.length - 1].t, ms('2026-03-04T02:00:00Z'));

  const shifted = C.coinMetricsSeries([{ asset: 'btc', time: '2026-03-03T23:45:00.000000000Z', ReferenceRateUSD: '1' }], { window: WIN, nowMs: ms(FINAL_NOW) });
  assert.equal(shifted.btc.baseline, null);
  assert.equal(C.parseCmTime('2026-03-04T00:15:00.123456789Z'), ms('2026-03-04T00:15:00Z'));
  assert.equal(C.parseCmTime('2026-03-04 00:15'), null);
});

test('buildSession: ok, missing, stale and error series with pct consistent with the baseline', () => {
  const t = (hhmm) => ms(kst(hhmm));
  const previous = C.buildSession({ date: DATE, window: WIN, nowMs: t('10:00'), results: [
    { id: 'taiex', source: { provider: 'yahoo', symbol: '^TWII' }, fetchedAt: t('10:00'), points: [{ t: t('10:00'), v: 101 }],
      baseline: { value: 100, label: '3/3 종가' }, note: '' }] });
  const results = [
    { id: 'kospi', source: { provider: 'yahoo', symbol: '^KS11' }, fetchedAt: t('10:15'),
      points: [{ t: t('09:00'), v: 2510.2 }, { t: t('09:15'), v: 2514.6 }], baseline: { value: 2500.5, label: '3/3 종가' }, note: '' },
    { id: 'nikkei', source: { provider: 'yahoo', symbol: '^N225' }, fetchedAt: t('10:15'), points: [], baseline: { value: 38000, label: '3/3 종가' }, note: '' },
    { id: 'taiex', source: { provider: 'yahoo', symbol: '^TWII' }, error: 'Yahoo HTTP 503' },
    { id: 'hsi', source: { provider: 'yahoo', symbol: '^HSI' }, error: C.NOTE_RATE_LIMITED },
    { id: 'nq', source: { provider: 'yahoo', symbol: 'NQ=F' }, fetchedAt: t('10:15'), points: [{ t: t('09:00'), v: 1 }], baseline: null, note: '' },
  ];
  const session = Core.validateSession(C.buildSession({ date: DATE, window: WIN, nowMs: t('10:15'), results, previous }));
  const s = byId(session);
  assert.equal(session.series.length, Core.SERIES.length);
  assert.deepEqual(session.series.map((x) => x.id), Core.SERIES.map((x) => x.id));
  assert.equal(session.final, false);
  assert.equal(session.generatedAt, kst('10:15'));
  assert.deepEqual(session.providers, JSON.parse(JSON.stringify(Core.PROVIDERS)));
  assert.equal(s.kospi.status, 'ok');
  assert.deepEqual(s.kospi.points[1], [kst('09:15'), 2514.6, Core.pctChange(2514.6, 2500.5)]);
  assert.equal(s.kospi.fetchedAt, kst('10:15'));
  assert.deepEqual([s.nikkei.status, s.nikkei.note, s.nikkei.baseline.value], ['missing', C.NOTE_NO_DATA, 38000]);
  assert.deepEqual([s.taiex.status, s.taiex.note, s.taiex.fetchedAt], ['stale', 'Yahoo HTTP 503', kst('10:00')]);
  assert.deepEqual(s.taiex.points, [[kst('10:00'), 101, 1]]);
  assert.deepEqual([s.hsi.status, s.hsi.note, s.hsi.baseline], ['error', C.NOTE_RATE_LIMITED, { value: null, label: '' }]);
  assert.deepEqual([s.nq.status, s.nq.points], ['missing', []]);
  assert.match(s.nq.note, /^기준값 없음/);
  assert.equal(s.btc.status, 'error'); // no result at all is reported, never invented
  assert.equal(C.buildSession({ date: DATE, window: WIN, nowMs: ms('2026-03-04T07:20:00Z'), results }).final, true);
  assert.equal(C.buildSession({ date: DATE, window: WIN, nowMs: ms('2026-03-04T07:19:59Z'), results }).final, false);
  // Points from a different window are never carried over.
  const other = Core.sessionWindow(DATE, '09:00', '16:00');
  const moved = byId(C.buildSession({ date: DATE, window: other, nowMs: t('10:15'), results, previous }));
  assert.equal(moved.taiex.status, 'error');
});

test('buildIndex lists sessions newest first with titles from notes and the number of series with data', () => {
  const session = (date, final, withData) => ({ date, final, generatedAt: `${date}T08:00:00Z`,
    series: Array.from({ length: 3 }, (_, i) => ({ points: i < withData ? [[`${date}T00:00:00Z`, 1, 0]] : [] })) });
  const index = Core.validateIndex(C.buildIndex([session('2026-03-03', true, 3), session('2026-03-04', false, 1)],
    new Map([['2026-03-03', { title: '노트 제목' }]]), ms('2026-03-04T08:00:01Z')));
  assert.equal(index.updatedAt, '2026-03-04T08:00:01Z');
  assert.deepEqual(index.sessions, [
    { date: '2026-03-04', title: null, final: false, seriesWithData: 1, updatedAt: '2026-03-04T08:00:00Z', hasNotes: false },
    { date: '2026-03-03', title: '노트 제목', final: true, seriesWithData: 3, updatedAt: '2026-03-03T08:00:00Z', hasNotes: true }]);
});

test('defaultDate picks the session whose window has started; weekends are KST weekends', () => {
  assert.equal(C.defaultDate(ms('2026-03-04T22:59:59Z')), '2026-03-04'); // 07:59:59 KST on 3/5
  assert.equal(C.defaultDate(ms('2026-03-04T23:00:00Z')), '2026-03-05'); // 08:00 KST on 3/5
  assert.equal(C.defaultDate(ms('2026-03-05T13:17:00Z')), '2026-03-05'); // 22:17 KST catch-up run
  assert.equal(C.defaultDate(ms('2026-03-04T23:30:00Z'), '09:00'), '2026-03-04');
  assert.deepEqual(['2026-03-06', '2026-03-07', '2026-03-08', '2026-03-09'].map(C.isWeekend), [false, true, true, false]);
});

test('shouldSkip: final sessions are skipped unless a series failed; recent runs are throttled; --force wins', () => {
  const later = ms('2026-03-04T08:17:00Z');
  const done = { generatedAt: '2026-03-04T07:25:00Z', final: true, window: WIN, series: [{ status: 'ok' }, { status: 'missing' }] };
  assert.equal(C.shouldSkip({ existing: done, nowMs: later }), 'final');
  assert.equal(C.shouldSkip({ existing: done, nowMs: later, force: true }), null);
  assert.equal(C.shouldSkip({ existing: null, nowMs: later }), null);
  assert.equal(C.shouldSkip({ existing: { ...done, series: [{ status: 'stale' }] }, nowMs: later }), null);
  assert.equal(C.shouldSkip({ existing: { ...done, series: [{ status: 'stale' }] }, nowMs: ms('2026-03-04T07:30:00Z') }), 'throttled');
  const early = { ...done, final: false, generatedAt: '2026-03-04T07:15:00Z' };
  assert.equal(C.shouldSkip({ existing: early, nowMs: ms('2026-03-04T07:24:59Z') }), 'throttled');
  assert.equal(C.shouldSkip({ existing: early, nowMs: ms('2026-03-04T07:25:00Z') }), null);
  // Final, but written less than 20 minutes after the window end: collect again once the throttle allows.
  assert.equal(C.shouldSkip({ existing: { ...done, generatedAt: '2026-03-04T07:19:00Z' }, nowMs: ms('2026-03-04T07:40:00Z') }), null);
});

test('request URLs: Yahoo range, interval and encoding; Coin Metrics assets, metric and paging', () => {
  const now = ms('2026-03-04T02:07:30Z');
  const u = new URL(C.yahooIntradayUrl('^KS11', WIN, now));
  assert.equal(`${u.origin}${u.pathname}`, 'https://query1.finance.yahoo.com/v8/finance/chart/%5EKS11');
  assert.deepEqual(Object.fromEntries(u.searchParams), { interval: '15m', period1: String(sec(WIN.start) - 3600),
    period2: String(Math.floor(now / 1000) + 60), includePrePost: 'false' });
  assert.equal(new URL(C.yahooIntradayUrl('NQ=F', WIN, ms(FINAL_NOW))).searchParams.get('period2'), String(sec(WIN.end) + 60));
  assert.equal(C.yahooDailyUrl('KRW=X'), 'https://query1.finance.yahoo.com/v8/finance/chart/KRW%3DX?interval=1d&range=1mo');
  const cm = new URL(C.coinMetricsUrl(['btc', 'eth', 'hype', 'zec', 'xmr'], WIN, now));
  assert.equal(`${cm.origin}${cm.pathname}`, 'https://community-api.coinmetrics.io/v4/timeseries/asset-metrics');
  assert.deepEqual(Object.fromEntries(cm.searchParams), { assets: 'btc,eth,hype,zec,xmr', metrics: 'ReferenceRateUSD',
    frequency: '1m', start_time: '2026-03-03T23:00:00Z', end_time: '2026-03-04T02:07:30Z', page_size: '10000', paging_from: 'start' });
});

test('httpTransport sends the honest User-Agent with a timeout signal', async () => {
  const original = globalThis.fetch;
  let seen = null;
  globalThis.fetch = async (url, init) => {
    seen = { url, init };
    return { status: 200, text: async () => '{"ok":true}' };
  };
  try {
    assert.deepEqual(await C.httpTransport('https://example.test/chart'), { status: 200, text: '{"ok":true}' });
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(seen.init.headers['User-Agent'], C.USER_AGENT);
  assert.match(C.USER_AGENT, /^chatgpt-dot-monitoring-hub\/2\.0 \(\+https:\/\/github\.com\/[^)]+\)$/);
  assert.equal(typeof seen.init.signal.aborted, 'boolean');
  assert.equal(seen.init.headers.Cookie, undefined);
});

test('requests: one retry after 3 s on 5xx or network errors, none on 4xx; Yahoo stops after HTTP 429', async () => {
  const sleeps = [];
  const sleep = async (n) => { sleeps.push(n); };
  let calls = 0;
  const flaky = async () => (++calls === 1 ? { status: 502, text: '' } : { status: 200, text: 'ok' });
  assert.deepEqual(await C.request(flaky, 'https://x.test/', sleep), { status: 200, text: 'ok' });
  assert.deepEqual([calls, sleeps], [2, [3000]]);
  calls = 0;
  const timeout = async () => { calls++; const e = new Error('t'); e.name = 'TimeoutError'; throw e; };
  assert.equal((await C.request(timeout, 'https://x.test/', sleep)).failure, '시간 초과');
  assert.equal(calls, 2);
  calls = 0;
  assert.equal((await C.request(async () => { calls++; return { status: 404, text: '' }; }, 'https://x.test/', sleep)).status, 404);
  assert.equal(calls, 1);

  const seen = [];
  const yahoo = C.yahooClient(async (url) => { seen.push(url); return { status: 429, text: '' }; }, sleep);
  assert.deepEqual(await yahoo.chart('https://query1.finance.yahoo.com/a'), { error: C.NOTE_RATE_LIMITED });
  assert.deepEqual(await yahoo.chart('https://query1.finance.yahoo.com/b'), { error: C.NOTE_RATE_LIMITED });
  assert.deepEqual(seen, ['https://query1.finance.yahoo.com/a']);
});

test('Coin Metrics paging follows same-host next_page_url only, at most 5 pages', async () => {
  const url = C.coinMetricsUrl(['btc'], WIN, ms(FINAL_NOW));
  const row = (minute) => ({ asset: 'btc', time: `2026-03-03T23:${String(minute).padStart(2, '0')}:00.000000000Z`, ReferenceRateUSD: '100' });
  const seen = [];
  const pages = async (u) => {
    seen.push(u);
    if (seen.length === 1) return { status: 200, text: JSON.stringify({ data: [row(0)], next_page_url: `${url}&next_page_token=2` }) };
    return { status: 200, text: JSON.stringify({ data: [row(15)], next_page_url: 'https://elsewhere.example/v4/timeseries/asset-metrics?x=1' }) };
  };
  const got = await C.fetchCoinMetrics(pages, noSleep, url, () => 5);
  assert.deepEqual([seen.length, got.rows.length, got.fetchedAt], [2, 2, 5]);
  let count = 0;
  const endless = async () => ({ status: 200, text: JSON.stringify({ data: [row(++count % 60)], next_page_url: `${url}&p=${count}` }) });
  assert.equal((await C.fetchCoinMetrics(endless, noSleep, url, () => 0)).rows.length, 5);
  assert.deepEqual(await C.fetchCoinMetrics(async () => ({ status: 200, text: '{"error":1}' }), noSleep, url, () => 0), { error: 'Coin Metrics 응답 형식 오류' });
});

// ---------------------------------------------------------------- whole runs (fixtures, temporary directories)

test('CLI --fixtures writes a valid session and index from the synthetic provider files', () => {
  const dir = tmpDir();
  try {
    const out = spawnSync(process.execPath, [SCRIPT, '--date', DATE, '--fixtures', FIX, '--now', FINAL_NOW, '--data-dir', dir], { encoding: 'utf8' });
    assert.equal(out.status, 0, out.stderr);
    const file = path.join(dir, 'sessions', `${DATE}.json`);
    const text = fs.readFileSync(file, 'utf8');
    const session = Core.validateSession(JSON.parse(text));
    assert.match(text, /\n {8}\["2026-03-04T00:00:00Z", 2510\.2, 0\.388\],\n/);
    const s = byId(session);
    assert.equal(session.final, true);
    assert.equal(session.generatedAt, FINAL_NOW);
    assert.deepEqual([s.kospi.status, s.kospi.baseline], ['ok', { value: 2500.5, label: '3/3 종가' }]);
    assert.deepEqual(s.kospi.points[s.kospi.points.length - 1], [kst('15:30'), 2523.6, Core.pctChange(2523.6, 2500.5)]);
    assert.deepEqual(s.nikkei.baseline, { value: 38000, label: C.LABEL_PREV_CLOSE_FALLBACK });
    assert.deepEqual([s.nq.baseline, s.nq.points[0]], [{ value: 20000.25, label: '08:00 KST 시가' }, [kst('08:00'), 20000.25, 0]]);
    assert.deepEqual([s.btc.status, s.btc.source], ['ok', { provider: 'coinmetrics', symbol: 'btc' }]);
    assert.equal(s.zec.baseline.label, '첫 관측 08:20 KST');
    assert.deepEqual([s.hype.status, s.hype.source, s.hype.note],
      ['ok', { provider: 'yahoo', symbol: 'HYPE32196-USD' }, 'Coin Metrics 자료 없음 · Yahoo 대체']);
    assert.deepEqual([s.xmr.status, s.xmr.note, s.xmr.points], ['error', 'Coin Metrics 자료 없음 · Yahoo HTTP 404', []]);
    assert.deepEqual([s.taiex.status, s.taiex.note], ['error', 'Yahoo HTTP 404']);
    for (const x of session.series) {
      if (x.status === 'ok') assert.equal(x.fetchedAt, FINAL_NOW);
      for (const p of x.points) assert.ok(Math.abs(p[2] - 100 * (p[1] / x.baseline.value - 1)) <= 0.0005 + 1e-12);
    }
    const index = Core.validateIndex(readJson(path.join(dir, 'index.json')));
    assert.deepEqual(index, { schemaVersion: 3, kind: 'index', updatedAt: FINAL_NOW, sessions: [
      { date: DATE, title: null, final: true, seriesWithData: 7, updatedAt: FINAL_NOW, hasNotes: false }] });
    assert.deepEqual(validateDataDir(dir).errors, []);
    const check = spawnSync(process.execPath, [VALIDATOR, dir], { encoding: 'utf8' });
    assert.equal(check.status, 0, check.stderr);

    // A final session that still has failed series is collected again by the catch-up runs; --dry-run never writes.
    const again = spawnSync(process.execPath, [SCRIPT, '--date', DATE, '--fixtures', FIX, '--now', '2026-03-04T08:30:00Z', '--data-dir', dir], { encoding: 'utf8' });
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /^Collecting 2026-03-04/);
    const before = fs.readFileSync(file, 'utf8');
    assert.equal(JSON.parse(before).generatedAt, '2026-03-04T08:30:00Z');
    const dry = spawnSync(process.execPath, [SCRIPT, '--date', DATE, '--fixtures', FIX, '--now', '2026-03-04T09:30:00Z', '--data-dir', dir, '--force', '--dry-run'], { encoding: 'utf8' });
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, /Dry run/);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    const bad = spawnSync(process.execPath, [SCRIPT, '--date', '2026-02-30', '--data-dir', dir], { encoding: 'utf8' });
    assert.equal(bad.status, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('HTTP 429 from Yahoo stops every later Yahoo request; Coin Metrics series are unaffected', async () => {
  const dir = tmpDir();
  try {
    const fixtures = C.fixtureTransport(FIX);
    const calls = [];
    const sleeps = [];
    const transport = async (url) => {
      calls.push(url);
      return url.includes('/NQ%3DF?') ? { status: 429, text: '' } : fixtures(url);
    };
    const res = await C.run({ date: DATE, now: FINAL_NOW, dataDir: dir, transport, sleep: async (n) => { sleeps.push(n); }, log: quiet });
    const yahooCalls = calls.filter((u) => u.includes('finance.yahoo.com'));
    assert.equal(yahooCalls.length, 7); // kospi intraday+daily, nikkei intraday+daily, taiex, hsi, nq (429)
    assert.ok(yahooCalls[6].includes('/NQ%3DF?'));
    assert.deepEqual(sleeps, [500, 500, 500, 500, 500, 500]);
    const s = byId(res.session);
    for (const id of ['nq', 'skhynix', 'samsung', 'tsmc', 'softbank', 'advantest', 'dxy', 'usdkrw', 'usdjpy', 'gold']) {
      assert.deepEqual([id, s[id].status, s[id].note], [id, 'error', C.NOTE_RATE_LIMITED]);
    }
    assert.equal(s.hype.note, `Coin Metrics 자료 없음 · ${C.NOTE_RATE_LIMITED}`);
    assert.deepEqual([s.kospi.status, s.btc.status, s.eth.status, s.zec.status], ['ok', 'ok', 'ok', 'ok']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('failed series keep their previous points as stale; the previous close is fetched once per session', async () => {
  const dir = tmpDir();
  try {
    const fixtures = C.fixtureTransport(FIX);
    const runAt = async (iso, transport) => {
      const calls = [];
      const sleeps = [];
      const res = await C.run({ date: DATE, now: iso, dataDir: dir, sleep: async (n) => { sleeps.push(n); }, log: quiet,
        transport: async (url) => { calls.push(url); return transport(url); } });
      return { res, calls, sleeps };
    };
    let first = true;
    const one = await runAt('2026-03-04T05:00:00Z', (url) => {
      if (first && url.includes('/%5EKS11?interval=15m')) {
        first = false;
        return { status: 503, text: '' };
      }
      return fixtures(url);
    });
    assert.ok(one.sleeps.includes(3000));
    const s1 = byId(one.res.session);
    assert.equal(s1.kospi.status, 'ok');
    assert.equal(one.res.final, false);
    assert.equal(one.calls.filter((u) => u.includes('interval=1d')).length, 2); // kospi, nikkei

    const throttled = await runAt('2026-03-04T05:05:00Z', fixtures);
    assert.deepEqual([throttled.res.status, throttled.res.reason, throttled.calls.length], ['skipped', 'throttled', 0]);

    const two = await runAt('2026-03-04T05:15:00Z', async (url) => {
      if (url.includes('/%5EKS11?')) throw new Error('socket hang up');
      return fixtures(url);
    });
    const s2 = byId(two.res.session);
    assert.deepEqual([s2.kospi.status, s2.kospi.note], ['stale', 'Yahoo 연결 실패']);
    assert.deepEqual(s2.kospi.points, s1.kospi.points);
    assert.deepEqual(s2.kospi.baseline, s1.kospi.baseline);
    assert.equal(s2.kospi.fetchedAt, '2026-03-04T05:00:00Z');
    assert.deepEqual([s2.taiex.status, s2.taiex.points], ['error', []]);
    // KOSPI's dated previous close is cached in the session file; Nikkei's fallback label is retried.
    const daily = two.calls.filter((u) => u.includes('interval=1d'));
    assert.deepEqual(daily.map((u) => decodeURIComponent(new URL(u).pathname.split('/').pop())), ['^N225']);

    const three = await runAt('2026-03-04T05:30:00Z', fixtures);
    const s3 = byId(three.res.session);
    assert.equal(s3.kospi.status, 'ok');
    assert.equal(three.calls.filter((u) => u.includes('/%5EKS11?interval=1d')).length, 0);
    assert.deepEqual(s3.kospi.baseline, { value: 2500.5, label: '3/3 종가' });
    assert.deepEqual(validateDataDir(dir).errors, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a Coin Metrics failure falls back to Yahoo for every crypto series', async () => {
  const dir = tmpDir();
  try {
    const fixtures = C.fixtureTransport(FIX);
    const cmCalls = [];
    const res = await C.run({ date: DATE, now: FINAL_NOW, dataDir: dir, sleep: noSleep, log: quiet,
      transport: async (url) => {
        if (url.includes('coinmetrics')) {
          cmCalls.push(url);
          return { status: 500, text: '' };
        }
        return fixtures(url);
      } });
    assert.equal(cmCalls.length, 2); // one retry
    const s = byId(res.session);
    assert.deepEqual([s.hype.status, s.hype.note], ['ok', 'Coin Metrics HTTP 500 · Yahoo 대체']);
    assert.deepEqual(s.hype.baseline, { value: 30.34, label: '08:00 KST' });
    assert.deepEqual([s.btc.status, s.btc.note], ['error', 'Coin Metrics HTTP 500 · Yahoo HTTP 404']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('weekends are skipped unless --date is given; an unstarted window is collected as missing without requests', async () => {
  const dir = tmpDir();
  try {
    const fixtures = C.fixtureTransport(FIX);
    const calls = [];
    const transport = async (url) => { calls.push(url); return fixtures(url); };
    const weekend = await C.run({ now: '2026-03-07T03:00:00Z', dataDir: dir, transport, sleep: noSleep, log: quiet });
    assert.deepEqual([weekend.status, weekend.reason, weekend.date, calls.length], ['skipped', 'weekend', '2026-03-07', 0]);
    assert.equal(fs.existsSync(path.join(dir, 'sessions')), false);
    const forced = await C.run({ date: '2026-03-07', now: '2026-03-07T03:00:00Z', dataDir: dir, transport, sleep: noSleep, log: quiet });
    assert.equal(forced.status, 'written');
    assert.ok(calls.length > 0);
    assert.equal(byId(forced.session).kospi.status, 'missing'); // the fixture has no bars for that day

    calls.length = 0;
    const ahead = await C.run({ date: '2026-03-09', now: '2026-03-08T12:00:00Z', dataDir: dir, transport, sleep: noSleep, log: quiet });
    assert.equal(calls.length, 0);
    assert.ok(ahead.session.series.every((x) => x.status === 'missing' && x.note === C.NOTE_NO_DATA));
    const index = readJson(path.join(dir, 'index.json'));
    assert.deepEqual(index.sessions.map((e) => e.date), ['2026-03-09', '2026-03-07']);
    assert.deepEqual(validateDataDir(dir).errors, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('parseArgs accepts the documented options and rejects malformed values', () => {
  assert.deepEqual(C.parseArgs(['--date=2026-03-04', '--start', '07:30', '--end', '18:00', '--force', '--dry-run', '--now', FINAL_NOW,
    '--data-dir', 'out', '--fixtures', 'fx']),
  { date: '2026-03-04', start: '07:30', end: '18:00', dataDir: 'out', now: FINAL_NOW, fixtures: 'fx', force: true, dryRun: true });
  assert.equal(C.parseArgs(['--date', '']).date, null);
  for (const bad of [['--date', '2026-02-30'], ['--date', '20260304'], ['--start', '8:00'], ['--end', '25:00'], ['--now', 'soon'],
    ['--date'], ['--frobnicate'], ['--force=yes']]) {
    assert.throws(() => C.parseArgs(bad), undefined, bad.join(' '));
  }
});

test('a final session without failures is not collected again, but a lagging index is still refreshed', async () => {
  const dir = tmpDir();
  try {
    const first = await C.run({ date: DATE, now: FINAL_NOW, dataDir: dir, transport: completeTransport(), sleep: noSleep, log: quiet });
    assert.ok(first.session.series.every((x) => x.status === 'ok'));
    let calls = 0;
    const counting = async (url) => { calls++; return completeTransport()(url); };
    const skipped = await C.run({ date: DATE, now: '2026-03-04T08:30:00Z', dataDir: dir, transport: counting, sleep: noSleep, log: quiet });
    assert.deepEqual([skipped.status, skipped.reason, skipped.final, skipped.indexWritten, calls], ['skipped', 'final', true, false, 0]);
    const sessionText = fs.readFileSync(path.join(dir, 'sessions', `${DATE}.json`), 'utf8');
    fs.mkdirSync(path.join(dir, 'notes'));
    fs.writeFileSync(path.join(dir, 'notes', `${DATE}.json`), JSON.stringify({ schemaVersion: 3, kind: 'notes', date: DATE, title: '합성 노트' }));
    assert.match(validateDataDir(dir).warnings.join('\n'), /does not list yet/);
    const res = await C.run({ date: DATE, now: '2026-03-04T09:00:00Z', dataDir: dir, transport: counting, sleep: noSleep, log: quiet });
    assert.deepEqual([res.status, res.reason, res.indexWritten, calls], ['skipped', 'final', true, 0]);
    assert.equal(fs.readFileSync(path.join(dir, 'sessions', `${DATE}.json`), 'utf8'), sessionText);
    const entry = readJson(path.join(dir, 'index.json')).sessions[0];
    assert.deepEqual([entry.title, entry.hasNotes, entry.updatedAt], ['합성 노트', true, FINAL_NOW]);
    const res2 = await C.run({ date: DATE, now: '2026-03-04T10:00:00Z', dataDir: dir, transport: counting, sleep: noSleep, log: quiet });
    assert.deepEqual([res2.indexWritten, calls], [false, 0]);
    const check = validateDataDir(dir);
    assert.deepEqual([check.errors, check.warnings], [[], []]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- validator

test('validate-parallel: the index must list exactly the session files and agree on final', async () => {
  const dir = tmpDir();
  try {
    assert.deepEqual(validateDataDir(dir).errors, []); // nothing collected yet
    await C.run({ date: DATE, now: FINAL_NOW, dataDir: dir, transport: C.fixtureTransport(FIX), sleep: noSleep, log: quiet });
    const indexFile = path.join(dir, 'index.json');
    const sessionFile = path.join(dir, 'sessions', `${DATE}.json`);
    const index = readJson(indexFile);
    const write = (file, obj) => fs.writeFileSync(file, `${JSON.stringify(obj)}\n`);

    write(indexFile, { ...index, sessions: [] });
    assert.match(validateDataDir(dir).errors.join('\n'), /sessions\/2026-03-04\.json is not listed/);
    const cli = spawnSync(process.execPath, [VALIDATOR, dir], { encoding: 'utf8' });
    assert.equal(cli.status, 1);
    assert.match(cli.stderr, /not listed/);

    write(indexFile, { ...index, sessions: [...index.sessions, { ...index.sessions[0], date: '2026-03-03' }] });
    assert.match(validateDataDir(dir).errors.join('\n'), /2026-03-03 is listed but sessions\/2026-03-03\.json does not exist/);

    write(indexFile, { ...index, sessions: [{ ...index.sessions[0], final: false }] });
    assert.match(validateDataDir(dir).errors.join('\n'), /final is false but the session file says true/);

    write(indexFile, index);
    fs.copyFileSync(sessionFile, path.join(dir, 'sessions', '2026-03-05.json'));
    const errors = validateDataDir(dir).errors.join('\n');
    assert.match(errors, /sessions\/2026-03-05\.json: date 2026-03-04 does not match the file name/);
    assert.match(errors, /sessions\/2026-03-05\.json is not listed/);
    fs.rmSync(path.join(dir, 'sessions', '2026-03-05.json'));

    fs.writeFileSync(path.join(dir, 'sessions', 'latest.json'), '{}');
    assert.match(validateDataDir(dir).errors.join('\n'), /latest\.json: file name must be YYYY-MM-DD\.json/);
    fs.rmSync(path.join(dir, 'sessions', 'latest.json'));

    fs.mkdirSync(path.join(dir, 'notes'));
    write(path.join(dir, 'notes', `${DATE}.json`), { schemaVersion: 3, kind: 'notes', date: DATE, events: [{ at: 'soon', label: 'x' }] });
    assert.match(validateDataDir(dir).errors.join('\n'), /notes\/2026-03-04\.json: notes\.events\[0\]\.at/);
    fs.rmSync(path.join(dir, 'notes', `${DATE}.json`));

    const session = readJson(sessionFile);
    session.series[0].points[0][2] += 1;
    write(sessionFile, session);
    assert.match(validateDataDir(dir).errors.join('\n'), /sessions\/2026-03-04\.json: session\.series\[0\]\.points\[0\]\[2\]/);
    fs.rmSync(indexFile);
    assert.match(validateDataDir(dir).errors.join('\n'), /index\.json: missing/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
