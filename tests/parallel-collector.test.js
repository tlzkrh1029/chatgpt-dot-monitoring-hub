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
const sessionFile = (dir, date = DATE) => path.join(dir, 'sessions', `${date}.json`);
const def = (id) => Core.SERIES.find((s) => s.id === id);
const ok = (obj) => ({ status: 200, text: JSON.stringify(obj) });
const timeoutError = () => Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });

// These tests never use the network: a run without an injected transport would reach httpTransport -> fetch.
globalThis.fetch = async (url) => {
  throw new Error(`network access in tests: ${url}`);
};

async function withDir(fn) {
  const dir = tmpDir();
  try {
    return await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Yahoo chart JSON from [[isoStart, open, close, {high, low, volume}?], ...] and day periods [[[isoStart, isoEnd], ...], ...]. */
function yahooJson({ bars, periods = [], rmt = null, cpc = null, gmtoffset = 0 }) {
  const meta = { gmtoffset, tradingPeriods: periods.map((day) => day.map(([a, b]) => ({ start: sec(a), end: sec(b) }))) };
  if (rmt) meta.regularMarketTime = sec(rmt);
  if (cpc) meta.chartPreviousClose = cpc;
  const quote = { open: bars.map((b) => b[1]), close: bars.map((b) => b[2]) };
  if (bars.some((b) => b[3])) {
    for (const key of ['high', 'low', 'volume']) quote[key] = bars.map((b) => (b[3] ? b[3][key] : null));
  }
  return { chart: { result: [{ meta, timestamp: bars.map((b) => sec(b[0])), indicators: { quote: [quote] } }], error: null } };
}
const chartOf = (spec) => C.parseYahooChart(yahooJson(spec));

/** Every 15-minute start from isoFrom to isoTo inclusive. */
function grid(isoFrom, isoTo) {
  const out = [];
  for (let t = ms(isoFrom); t <= ms(isoTo); t += 900e3) out.push(Core.isoUtc(t));
  return out;
}

/** Yahoo symbol and interval of a request URL, or null for another host. */
function yahooInfo(url) {
  const u = new URL(url);
  if (u.hostname !== 'query1.finance.yahoo.com') return null;
  return { symbol: decodeURIComponent(u.pathname.split('/').pop()), daily: u.searchParams.get('interval') === '1d' };
}

/**
 * Transport over the fixtures (or `base`) with an override: override(url, yahooInfo) returns a response,
 * an Error to throw, or undefined for the base answer. Records every URL in t.calls.
 */
function transportWith(override, base = C.fixtureTransport(FIX)) {
  const calls = [];
  const t = async (url) => {
    calls.push(url);
    const r = override ? await override(url, yahooInfo(url)) : undefined;
    if (r instanceof Error) throw r;
    return r === undefined ? base(url) : r;
  };
  t.calls = calls;
  t.yahoo = () => calls.filter((u) => yahooInfo(u));
  return t;
}

/** Fixture transport that answers every Yahoo intraday request lacking a fixture with a generic 24h chart. */
function completeTransport() {
  const fixtures = C.fixtureTransport(FIX);
  const generic = fs.readFileSync(path.join(FIX, 'HYPE32196-USD.intraday.json'), 'utf8');
  return async (url) => {
    const res = await fixtures(url);
    return res.status === 404 && url.includes('interval=15m') ? { status: 200, text: generic } : res;
  };
}

/** One collection of DATE (or extra.date) at `now` into dir from the fixtures, silent and without sleeping. */
const runAt = (dir, now, extra = {}) => C.run({ date: DATE, now, dataDir: dir, sleep: noSleep, log: quiet,
  transport: C.fixtureTransport(FIX), ...extra });

/** A fixture chart response with the bars starting at or after cutIso removed (a truncated answer). */
function truncatedAnswer(name, cutIso) {
  const j = fixture(name);
  const r = j.chart.result[0];
  const keep = r.timestamp.map((t, i) => (t < sec(cutIso) ? i : -1)).filter((i) => i >= 0);
  r.timestamp = keep.map((i) => r.timestamp[i]);
  for (const k of Object.keys(r.indicators.quote[0])) r.indicators.quote[0][k] = keep.map((i) => r.indicators.quote[0][k][i]);
  return ok(j);
}

/** A fixture chart response reduced to its meta: HTTP 200 without a single bar. */
function metaOnlyAnswer(name) {
  const meta = fixture(name).chart.result[0].meta;
  return ok({ chart: { result: [{ meta, indicators: { quote: [{}] } }], error: null } });
}

/** Value of a raw fixture bar (cleaned like the collector does). */
function barValue(file, field, hhmm, date = DATE) {
  const r = fixture(file).chart.result[0];
  const i = r.timestamp.indexOf(sec(kst(hhmm, date)));
  assert.ok(i >= 0, `${file} has a bar at ${hhmm} KST`);
  return C.cleanPrice(r.indicators.quote[0][field][i]);
}

/** Runs the CLI with GITHUB_OUTPUT/GITHUB_ACTIONS set -> {status, stdout, stderr, output: {key: value}}. */
function cli(args, dir) {
  const outFile = path.join(dir, `github-output-${Math.random().toString(36).slice(2)}.txt`);
  const env = { ...process.env, GITHUB_OUTPUT: outFile, GITHUB_ACTIONS: 'true' };
  const res = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env });
  const text = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8') : '';
  fs.rmSync(outFile, { force: true });
  const output = Object.fromEntries(text.split('\n').filter(Boolean).map((line) => {
    const eq = line.indexOf('=');
    return [line.slice(0, eq), line.slice(eq + 1)];
  }));
  return { status: res.status, stdout: res.stdout, stderr: res.stderr, output, raw: text };
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

test('parseYahooChart normalizes bars (with high, low, volume), trading periods and meta, and rejects unusable responses', () => {
  const chart = C.parseYahooChart(fixture('_KS11.intraday.json'));
  assert.equal(chart.bars.length, 25);
  assert.deepEqual(chart.bars[0], { ts: sec(kst('09:00')), open: 2510.2, high: null, low: null, close: 2514.6, volume: null });
  assert.deepEqual(chart.bars[6], { ts: sec(kst('10:30')), open: null, high: null, low: null, close: null, volume: null });
  assert.deepEqual(chart.periods, [{ start: sec(kst('09:00')), end: sec(kst('15:00')), lastOfDay: true }]);
  assert.equal(chart.gmtoffset, 32400);
  assert.equal(chart.chartPreviousClose, 2500.5);
  assert.equal(chart.regularMarketTime, sec(kst('15:30')));
  const full = chartOf({ bars: [[kst('09:00'), 10, 11, { high: Math.fround(11.5), low: 9.75, volume: 1200 }]] });
  assert.deepEqual(full.bars, [{ ts: sec(kst('09:00')), open: 10, high: 11.5, low: 9.75, close: 11, volume: 1200 }]);

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

test('yahooPoints: a closing print stamped after the configured close stays at its own time (data-06)', () => {
  // A special-hours day (CSAT: KRX trades until 16:30): Yahoo's period and print bar move one hour later,
  // so the print bar starts at 16:00, after the configured 15:30 close.
  const chart = chartOf({ periods: [[[kst('10:00'), kst('16:00')]]], gmtoffset: 32400, rmt: kst('16:30'),
    bars: [[kst('15:00'), 100, 101], [kst('15:15'), 101, 102], [kst('15:30'), 102, 103], [kst('15:45'), 103, 104],
      [kst('16:00'), 105, 105]] });
  const points = view(C.yahooPoints(chart, { window: WIN, nowMs: ms(kst('17:30')), closeKst: '15:30' }));
  // The 15:30 value is the real end of the 15:15 bar; the print is plotted at its own bar time (16:00).
  assert.deepEqual(points, [['15:00', 100], ['15:15', 101], ['15:30', 102], ['15:45', 103], ['16:00', 105]]);
  // Before that bar starts it is not a print yet.
  assert.deepEqual(view(C.yahooPoints(chart, { window: WIN, nowMs: ms(kst('15:59')), closeKst: '15:30' })).slice(-1), [['15:59', 104]]);
});

test('yahooPoints: lunch-break prints stay at the break start (Nikkei 11:30, Hang Seng 13:00 KST; data-07)', () => {
  const file = '_N225.intraday.json';
  const chart = C.parseYahooChart(fixture(file));
  const close = (h) => barValue(file, 'close', h);
  const open = (h) => barValue(file, 'open', h);
  const v = view(C.yahooPoints(chart, { window: WIN, nowMs: ms(FINAL_NOW), closeKst: '15:30', breakKst: '11:30' }));
  // The 11:30 bar is the morning-close print: plotted at 11:30, nothing during the break.
  assert.deepEqual(v.filter(([t]) => t >= '11:15' && t <= '12:45'),
    [['11:15', close('11:00')], ['11:30', close('11:30')], ['12:30', open('12:30')], ['12:45', close('12:30')]]);
  assert.deepEqual(v[v.length - 1], ['15:30', close('15:30')]);
  assert.equal(v.length, 24);
  // Without breakKst the print bar is an ordinary bar ending 15 minutes into the break.
  const plain = view(C.yahooPoints(chart, { window: WIN, nowMs: ms(FINAL_NOW), closeKst: '15:30' }));
  assert.deepEqual(plain.filter(([t]) => t >= '11:30' && t <= '11:45'), [['11:30', close('11:15')], ['11:45', close('11:30')]]);

  const hsi = chartOf({ periods: [[[kst('10:30'), kst('17:10')]]], gmtoffset: 28800,
    bars: [[kst('12:45'), 200, 201], [kst('13:00'), 201.5, 202], [kst('13:15'), null, null], [kst('13:30'), null, null],
      [kst('13:45'), null, null], [kst('14:00'), 203, 204]] });
  const h = view(C.yahooPoints(hsi, { window: WIN, nowMs: ms(kst('14:20')), closeKst: '17:10', breakKst: '13:00' }));
  assert.deepEqual(h, [['12:45', 200], ['13:00', 202], ['14:00', 203], ['14:15', 204]]);
  // A half day (morning only): the break print is the day's close and stays at 13:00.
  const half = chartOf({ periods: [[[kst('10:30'), kst('13:00')]]], gmtoffset: 28800, bars: [[kst('12:45'), 200, 201], [kst('13:00'), 202, 202]] });
  assert.deepEqual(view(C.yahooPoints(half, { window: WIN, nowMs: ms(FINAL_NOW), closeKst: '17:10', breakKst: '13:00' })),
    [['12:45', 200], ['13:00', 202]]);
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

test('yahooBaseline (window start): 08:00 close, else the 08:00 open, else the first point in the window however late', () => {
  const now = ms(FINAL_NOW);
  const base = (chart) => C.yahooBaseline(chart, { basis: 'windowStart', window: WIN, points: C.yahooPoints(chart, { window: WIN, nowMs: now }) });
  const hype = C.parseYahooChart(fixture('HYPE32196-USD.intraday.json'));
  assert.deepEqual(base(hype), { value: barValue('HYPE32196-USD.intraday.json', 'close', '07:45'), label: '08:00 KST' });
  // CME break: the 07:45 bar is empty, so the 08:00 bar's open is the value at 08:00.
  assert.deepEqual(base(C.parseYahooChart(fixture('NQ_F.intraday.json'))), { value: 20000.25, label: '08:00 KST 시가' });
  assert.deepEqual(base(chartOf({ bars: [[kst('08:15'), 50, 51], [kst('08:30'), 51, 52]] })), { value: 50, label: '첫 관측 08:15 KST' });
  // No 30-minute limit any more (data-01): a later first observation is still the honest baseline.
  assert.deepEqual(base(chartOf({ bars: [[kst('08:45'), 50, 51]] })), { value: 50, label: '첫 관측 08:45 KST' });
  assert.deepEqual(base(chartOf({ bars: [[kst('14:59'), 50, 51]] })), { value: 51, label: '첫 관측 14:59 KST' });
  // Nothing inside the window: no baseline.
  assert.equal(base(chartOf({ bars: [[kst('16:15'), 50, 51]] })), null);
  assert.equal(base(chartOf({ bars: [] })), null);
});

test('data-01: Monday FX (first bar 09:00 KST) and DXY under US daylight time (first bar 08:45 KST) keep their points', async () => {
  const MON = '2026-03-09'; // Monday; window 2026-03-08T23:00Z .. 2026-03-09T07:00Z (US daylight time since 3/8)
  const k = (hhmm) => kst(hhmm, MON);
  // Yahoo KRW=X / JPY=X: Friday's bars end at 23:45Z, the next bar is Monday 00:00Z (09:00 KST).
  const fx = yahooJson({ gmtoffset: 0,
    periods: [[['2026-03-06T00:00:00Z', '2026-03-06T23:59:00Z']], [['2026-03-09T00:00:00Z', '2026-03-09T23:59:00Z']]],
    bars: [['2026-03-06T23:30:00Z', 1400, 1401], ['2026-03-06T23:45:00Z', 1401, 1402],
      ...grid('2026-03-09T00:00:00Z', '2026-03-09T07:00:00Z').map((t, i) => [t, 1410 + i, 1411 + i])] });
  // DX-Y.NYB: null bars 22:15Z-23:30Z (18:15-19:30 ET), first value 23:45Z (08:45 KST).
  const dxy = yahooJson({ gmtoffset: -14400, periods: [[['2026-03-08T22:00:00Z', '2026-03-09T21:59:00Z']]],
    bars: [['2026-03-08T22:00:00Z', 99, 99.1], ...grid('2026-03-08T22:15:00Z', '2026-03-08T23:30:00Z').map((t) => [t, null, null]),
      ...grid('2026-03-08T23:45:00Z', '2026-03-09T07:00:00Z').map((t, i) => [t, 99.2 + i / 100, 99.21 + i / 100])] });
  const chartFx = C.parseYahooChart(fx);
  const winMon = Core.sessionWindow(MON);
  const fxPoints = C.yahooPoints(chartFx, { window: winMon, nowMs: ms(k('16:30')) });
  assert.deepEqual(C.yahooBaseline(chartFx, { basis: 'windowStart', window: winMon, points: fxPoints }), { value: 1410, label: '첫 관측 09:00 KST' });
  // Coin Metrics uses the same rule: the first row in the window, however late.
  const cm = C.coinMetricsSeries([{ asset: 'btc', time: '2026-03-09T00:00:00.000000000Z', ReferenceRateUSD: '70000' },
    { asset: 'btc', time: '2026-03-09T00:15:00.000000000Z', ReferenceRateUSD: '70100' }], { window: winMon, nowMs: ms(k('16:30')) });
  assert.deepEqual(cm.btc.baseline, { value: 70000, label: '첫 관측 09:00 KST' });

  await withDir(async (dir) => {
    const transport = transportWith((url, y) => {
      if (!y) return { status: 404, text: '' };
      if (y.symbol === 'KRW=X' || y.symbol === 'JPY=X') return ok(fx);
      if (y.symbol === 'DX-Y.NYB') return ok(dxy);
      return { status: 404, text: '' };
    });
    const res = await runAt(dir, k('16:30'), { date: MON, transport });
    const s = byId(res.session);
    for (const id of ['usdkrw', 'usdjpy']) {
      assert.deepEqual([s[id].status, s[id].baseline, s[id].points.length], ['ok', { value: 1410, label: '첫 관측 09:00 KST' }, 29]);
      assert.deepEqual(s[id].points[0], [k('09:00'), 1410, 0]);
      assert.deepEqual(s[id].points[28], [k('16:00'), 1438, Core.pctChange(1438, 1410)]);
    }
    assert.deepEqual([s.dxy.status, s.dxy.baseline, s.dxy.points.length], ['ok', { value: 99.2, label: '첫 관측 08:45 KST' }, 30]);
    assert.equal(s.dxy.points[0][0], k('08:45'));
    assert.deepEqual(validateDataDir(dir).errors, []);
  });
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

test('dailyPrevClose dates bars by the exchange gmtoffset (tests-06 K29)', () => {
  // Daily bars stamped 15:00Z belong to the next local day in Seoul (UTC+9).
  const daily = chartOf({ gmtoffset: 32400, bars: [['2026-03-02T15:00:00Z', 99, 100], ['2026-03-03T15:00:00Z', 100, 101]] });
  assert.deepEqual(C.dailyPrevClose(daily, '2026-03-04'), { value: 100, label: '3/3 종가' });
  assert.deepEqual(C.dailyPrevClose({ ...daily, gmtoffset: 0 }, '2026-03-04'), { value: 101, label: '3/3 종가' });
});

test('dailyPrevClose skips flat zero-volume holiday placeholder bars (data-08)', () => {
  // TSMC after the 10/23 Taiwan holiday: Yahoo fills 10/23 with o=h=l=c, volume 0 while TAIEX has no bar.
  const flat = { high: 2385, low: 2385, volume: 0 };
  const tsmc = chartOf({ gmtoffset: 28800, bars: [['2026-10-22T01:00:00Z', 2400, 2385, { high: 2410, low: 2380, volume: 22930116 }],
    ['2026-10-23T01:00:00Z', 2385, 2385, flat], ['2026-10-27T01:00:00Z', 2390, 2400, { high: 2405, low: 2385, volume: 33964182 }]] });
  assert.equal(C.isPlaceholderBar(tsmc.bars[1]), true);
  assert.deepEqual(C.dailyPrevClose(tsmc, '2026-10-27'), { value: 2385, label: '10/22 종가' });
  // A flat bar with volume, or a zero-volume bar that moved (indices report volume 0), is a real close.
  const traded = chartOf({ gmtoffset: 28800, bars: [['2026-10-23T01:00:00Z', 2385, 2385, { ...flat, volume: 10 }]] });
  assert.deepEqual(C.dailyPrevClose(traded, '2026-10-27'), { value: 2385, label: '10/23 종가' });
  const index = chartOf({ gmtoffset: 32400, bars: [['2026-10-23T00:00:00Z', 100, 101, { high: 102, low: 99, volume: 0 }]] });
  assert.deepEqual(C.dailyPrevClose(index, '2026-10-27'), { value: 101, label: '10/23 종가' });
  // Without volume data nothing is skipped.
  assert.equal(C.isPlaceholderBar({ open: 1, high: 1, low: 1, close: 1, volume: null }), false);
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

  // A first row 45 minutes after the start is still the baseline (no 30-minute limit, data-01).
  const shifted = C.coinMetricsSeries([{ asset: 'btc', time: '2026-03-03T23:45:00.000000000Z', ReferenceRateUSD: '1' }], { window: WIN, nowMs: ms(FINAL_NOW) });
  assert.deepEqual(shifted.btc.baseline, { value: 1, label: '첫 관측 08:45 KST' });
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
  // Points without a baseline are a failure (never 'missing', which would claim there was no data).
  assert.deepEqual([s.nq.status, s.nq.note, s.nq.points], ['error', C.NOTE_NO_BASELINE, []]);
  assert.equal(s.btc.status, 'error'); // no result at all is reported, never invented
  assert.equal(C.buildSession({ date: DATE, window: WIN, nowMs: ms('2026-03-04T07:20:00Z'), results }).final, true);
  assert.equal(C.buildSession({ date: DATE, window: WIN, nowMs: ms('2026-03-04T07:19:59Z'), results }).final, false);
  // Points from a different window are never carried over.
  const other = Core.sessionWindow(DATE, '09:00', '16:00');
  const moved = byId(C.buildSession({ date: DATE, window: other, nowMs: t('10:15'), results, previous }));
  assert.equal(moved.taiex.status, 'error');
});

test('buildSeries merges a shorter answer of the same source instead of replacing stored points (data-02, security-1)', () => {
  const ws = ms(WIN.start);
  const we = ms(WIN.end);
  const nq = def('nq');
  const src = { provider: 'yahoo', symbol: 'NQ=F' };
  const p = (hhmm, v, base = 100) => [kst(hhmm), v, Core.pctChange(v, base)];
  const prev = { id: 'nq', basis: 'windowStart', baseline: { value: 100, label: '08:00 KST' }, source: src, status: 'ok', note: '',
    fetchedAt: kst('10:07'), points: [p('08:00', 100), p('08:15', 101), p('08:30', 102), p('08:45', 103), p('09:00', 104),
      p('09:15', 105), p('09:30', 106), p('09:45', 107), p('10:00', 108), p('10:07', 109)] };
  const fresh = (list, baseline = { value: 100, label: '08:00 KST' }) => ({ id: 'nq', source: src, fetchedAt: ms(kst('10:22')),
    points: list.map(([hhmm, v]) => ({ t: ms(kst(hhmm)), v })), baseline, note: '' });

  // Empty 200 answer: everything stored is kept, marked stale; never 'missing' with a holiday note.
  const empty = C.buildSeries(nq, fresh([]), prev, ws, we);
  assert.deepEqual([empty.status, empty.note, empty.fetchedAt, empty.points], ['stale', C.NOTE_KEPT_EMPTY, kst('10:07'), prev.points]);
  assert.deepEqual(empty.baseline, prev.baseline);

  // Truncated answer (ends at 09:00): stored later points are merged in, new values win where both exist.
  const cut = C.buildSeries(nq, fresh([['08:00', 100], ['08:15', 101.5], ['08:30', 102], ['08:45', 103], ['09:00', 104]],
    { value: 100.5, label: '08:00 KST' }), prev, ws, we);
  assert.deepEqual([cut.status, cut.note, cut.fetchedAt], ['stale', C.NOTE_KEPT_PARTIAL, kst('10:22')]);
  assert.deepEqual(cut.baseline, { value: 100.5, label: '08:00 KST' });
  assert.deepEqual(cut.points.map((x) => [Core.kstTime(x[0]), x[1]]),
    [['08:00', 100], ['08:15', 101.5], ['08:30', 102], ['08:45', 103], ['09:00', 104], ['09:15', 105], ['09:30', 106], ['09:45', 107], ['10:00', 108], ['10:07', 109]]);
  for (const x of cut.points) assert.equal(x[2], Core.pctChange(x[1], 100.5)); // recomputed against the chosen baseline

  // An answer that lost its start: stored earlier points fill it; a later first observation keeps the stored baseline.
  const late = C.buildSeries(nq, fresh([['09:00', 104], ['09:15', 105.5], ['09:30', 106], ['09:45', 107], ['10:00', 108], ['10:22', 110]],
    { value: 104, label: '첫 관측 09:00 KST' }), prev, ws, we);
  assert.deepEqual([late.status, late.note, late.baseline], ['ok', C.NOTE_FILLED_START, { value: 100, label: '08:00 KST' }]);
  assert.deepEqual(late.points.map((x) => x[0]).slice(0, 5), ['08:00', '08:15', '08:30', '08:45', '09:00'].map((h) => kst(h)));
  assert.deepEqual(late.points[5], p('09:15', 105.5));

  // A complete answer replaces the stored live tick (10:07) inside its span: nothing stale, no note.
  const full = C.buildSeries(nq, fresh([['08:00', 100], ['08:15', 101], ['09:45', 107], ['10:00', 108], ['10:15', 108.5], ['10:22', 110]]), prev, ws, we);
  assert.deepEqual([full.status, full.note], ['ok', '']);
  assert.deepEqual(full.points.map((x) => Core.kstTime(x[0])), ['08:00', '08:15', '09:45', '10:00', '10:15', '10:22']);

  // Another source (a fallback) that ends earlier than the stored points: the stored series is kept as stale.
  const crypto = def('btc');
  const cmPrev = { ...prev, id: 'btc', source: { provider: 'coinmetrics', symbol: 'btc' } };
  const fallback = { ...fresh([['08:00', 100], ['08:15', 101]]), id: 'btc', source: { provider: 'yahoo', symbol: 'BTC-USD' },
    note: 'Coin Metrics HTTP 500 · Yahoo 대체' };
  const keptCm = C.buildSeries(crypto, fallback, cmPrev, ws, we);
  assert.deepEqual([keptCm.status, keptCm.source, keptCm.points.length], ['stale', { provider: 'coinmetrics', symbol: 'btc' }, 10]);
  assert.equal(keptCm.note, `Coin Metrics HTTP 500 · Yahoo 대체 · ${C.NOTE_KEPT_PARTIAL}`);
  // ... but a fallback reaching at least as far replaces it.
  const switched = C.buildSeries(crypto, { ...fallback, points: fresh([['08:00', 100], ['10:22', 110]]).points }, cmPrev, ws, we);
  assert.deepEqual([switched.status, switched.source, switched.points.length], ['ok', { provider: 'yahoo', symbol: 'BTC-USD' }, 2]);
  // An empty fallback answer never wipes the stored series either.
  const emptyFallback = C.buildSeries(crypto, { ...fallback, points: [] }, cmPrev, ws, we);
  assert.deepEqual([emptyFallback.status, emptyFallback.source, emptyFallback.points.length], ['stale', cmPrev.source, 10]);
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

test('shouldSkip: final sessions are skipped, failed ones repaired hourly; the 10-minute throttle needs throttle; --force wins', () => {
  const later = ms('2026-03-04T08:17:00Z');
  const done = { generatedAt: '2026-03-04T07:25:00Z', final: true, window: WIN, series: [{ status: 'ok' }, { status: 'missing' }] };
  assert.equal(C.shouldSkip({ existing: done, nowMs: later }), 'final');
  assert.equal(C.shouldSkip({ existing: done, nowMs: later, force: true }), null);
  assert.equal(C.shouldSkip({ existing: null, nowMs: later }), null);
  // A final file with a stale or error series is collected again once it is 60 minutes old (security-4).
  for (const status of ['stale', 'error']) {
    const failed = { ...done, series: [{ status: 'ok' }, { status }] };
    assert.equal(C.shouldSkip({ existing: failed, nowMs: ms('2026-03-04T07:30:00Z') }), 'repair-wait');
    assert.equal(C.shouldSkip({ existing: failed, nowMs: ms('2026-03-04T08:24:59Z') }), 'repair-wait');
    assert.equal(C.shouldSkip({ existing: failed, nowMs: ms('2026-03-04T08:25:00Z') }), null);
    assert.equal(C.shouldSkip({ existing: failed, nowMs: ms('2026-03-04T07:30:00Z'), force: true }), null);
    assert.equal(C.shouldSkip({ existing: failed, nowMs: ms('2026-03-04T12:00:00Z'), throttle: true }), null);
    // Repairs stop 8 hours after the window end; --force still repairs.
    assert.equal(C.shouldSkip({ existing: failed, nowMs: ms('2026-03-04T15:00:00Z') }), null);
    assert.equal(C.shouldSkip({ existing: failed, nowMs: ms('2026-03-04T15:00:01Z') }), 'repair-closed');
    assert.equal(C.shouldSkip({ existing: failed, nowMs: ms('2026-03-04T15:00:01Z'), throttle: true }), 'repair-closed');
    assert.equal(C.shouldSkip({ existing: failed, nowMs: ms('2026-03-04T15:00:01Z'), force: true }), null);
  }
  // The 10-minute throttle applies only to throttled (push-triggered) runs (data-09).
  const early = { ...done, final: false, generatedAt: '2026-03-04T07:15:00Z' };
  assert.equal(C.shouldSkip({ existing: early, nowMs: ms('2026-03-04T07:24:59Z') }), null);
  assert.equal(C.shouldSkip({ existing: early, nowMs: ms('2026-03-04T07:24:59Z'), throttle: true }), 'throttled');
  assert.equal(C.shouldSkip({ existing: early, nowMs: ms('2026-03-04T07:25:00Z'), throttle: true }), null);
  assert.equal(C.shouldSkip({ existing: early, nowMs: ms('2026-03-04T07:24:59Z'), throttle: true, force: true }), null);
  // Final, but written less than 20 minutes after the window end: collect again.
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

test('User-Agent names the repository that runs the collector (security-8)', async () => {
  const upstream = 'chatgpt-dot-monitoring-hub/2.0 (+https://github.com/tlzkrh1029/chatgpt-dot-monitoring-hub)';
  assert.equal(C.USER_AGENT, upstream);
  assert.equal(C.userAgent({}), upstream);
  assert.equal(C.userAgent({ GITHUB_REPOSITORY: 'someone/fork-hub' }), 'chatgpt-dot-monitoring-hub/2.0 (+https://github.com/someone/fork-hub)');
  assert.equal(C.userAgent({ GITHUB_REPOSITORY: 'org/hub', GITHUB_SERVER_URL: 'https://ghe.example.com/' }),
    'chatgpt-dot-monitoring-hub/2.0 (+https://ghe.example.com/org/hub)');
  for (const env of [{ GITHUB_REPOSITORY: 'bad repo/x' }, { GITHUB_REPOSITORY: 'a/b/c' }, { GITHUB_SERVER_URL: 'https://evil.example' },
    { GITHUB_REPOSITORY: 'org/hub', GITHUB_SERVER_URL: 'http://plain.example' }]) {
    assert.match(C.userAgent(env), /^chatgpt-dot-monitoring-hub\/2\.0 \(\+https:\/\/github\.com\/[^)]+\)$/, JSON.stringify(env));
  }

  const original = globalThis.fetch;
  const saved = process.env.GITHUB_REPOSITORY;
  let seen = null;
  globalThis.fetch = async (url, init) => {
    seen = { url, init };
    return { status: 200, text: async () => '{"ok":true}' };
  };
  try {
    process.env.GITHUB_REPOSITORY = 'someone/fork-hub';
    assert.deepEqual(await C.httpTransport('https://example.test/chart'), { status: 200, text: '{"ok":true}' });
  } finally {
    globalThis.fetch = original;
    if (saved === undefined) delete process.env.GITHUB_REPOSITORY;
    else process.env.GITHUB_REPOSITORY = saved;
  }
  assert.match(seen.init.headers['User-Agent'], /\(\+https:\/\/[^/]+\/someone\/fork-hub\)$/);
  assert.equal(seen.init.redirect, 'manual'); // a consent or bot-check redirect comes back as a 3xx refusal
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
  const timeout = async () => { calls++; throw timeoutError(); };
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
  assert.equal(yahoo.stopped, C.NOTE_RATE_LIMITED);
});

test('Yahoo refusals (401, 403, 451, 3xx, a 200 that is not JSON) stop Yahoo like 429; other errors do not (data-05, security-6)', async () => {
  const answers = {
    401: [{ status: 401, text: '{"finance":{"error":{"code":"Unauthorized","description":"Invalid Crumb"}}}' }, 'Yahoo 접근 거부(HTTP 401)'],
    403: [{ status: 403, text: '<html>Forbidden</html>' }, 'Yahoo 접근 거부(HTTP 403)'],
    451: [{ status: 451, text: '' }, 'Yahoo 접근 거부(HTTP 451)'],
    302: [{ status: 302, text: 'moved' }, 'Yahoo 접근 거부(HTTP 302)'],
    html: [{ status: 200, text: '<!doctype html><html><body>consent</body></html>' }, 'Yahoo 접근 거부(JSON 아닌 응답)'],
  };
  for (const [key, [answer, note]] of Object.entries(answers)) {
    await withDir(async (dir) => {
      const transport = transportWith((url, y) => (y ? answer : undefined));
      const res = await runAt(dir, kst('12:00'), { transport });
      assert.equal(transport.yahoo().length, 1, key);
      const s = byId(res.session);
      for (const id of ['kospi', 'nikkei', 'nq', 'gold']) assert.deepEqual([key, s[id].status, s[id].note], [key, 'error', note]);
      assert.deepEqual([s.btc.status, s.btc.source.provider], ['ok', 'coinmetrics']); // Coin Metrics is unaffected
    });
  }
  // A 404 (unknown symbol) or a JSON answer of the wrong shape stays a per-series error.
  const yahoo = C.yahooClient(async (url) => (url.endsWith('a') ? { status: 404, text: '' } : { status: 200, text: '{"x":1}' }), noSleep);
  assert.deepEqual(await yahoo.chart('https://query1.finance.yahoo.com/a'), { error: 'Yahoo HTTP 404' });
  assert.deepEqual(await yahoo.chart('https://query1.finance.yahoo.com/b'), { error: 'Yahoo 응답 형식 오류' });
  assert.equal(yahoo.stopped, null);
});

test('two Yahoo requests in a row without an answer stop Yahoo for the run; an answer in between resets the count', async () => {
  await withDir(async (dir) => {
    let attempts = 0;
    const sleeps = [];
    const transport = transportWith((url, y) => {
      if (!y) return undefined;
      attempts += 1;
      return timeoutError();
    });
    const res = await runAt(dir, kst('12:00'), { transport, sleep: async (n) => { sleeps.push(n); } });
    assert.equal(attempts, 4); // two requests, each retried once after 3 s
    assert.deepEqual(sleeps, [3000, 500, 3000]);
    const s = byId(res.session);
    assert.deepEqual([s.kospi.note, s.nikkei.note, s.taiex.note, s.gold.note], ['Yahoo 시간 초과', 'Yahoo 시간 초과', C.NOTE_SILENT, C.NOTE_SILENT]);
  });
  // Attempts 1-2 time out (request a), attempt 3 answers 404 (request b), attempts 4-5 time out (request c).
  let n = 0;
  const yahoo = C.yahooClient(async () => {
    n += 1;
    if (n === 3) return { status: 404, text: '' };
    throw timeoutError();
  }, noSleep);
  assert.deepEqual(await yahoo.chart('https://query1.finance.yahoo.com/a'), { error: 'Yahoo 시간 초과' });
  assert.deepEqual(await yahoo.chart('https://query1.finance.yahoo.com/b'), { error: 'Yahoo HTTP 404' });
  assert.deepEqual(await yahoo.chart('https://query1.finance.yahoo.com/c'), { error: 'Yahoo 시간 초과' });
  assert.deepEqual([n, yahoo.stopped], [5, null]);
});

test('no provider request starts after the 6-minute run deadline; the run still writes what it has', async () => {
  await withDir(async (dir) => {
    let clockMs = 0;
    const transport = transportWith(() => {
      clockMs += 50e3; // every request takes 50 s
      return undefined;
    });
    const res = await runAt(dir, kst('12:00'), { transport, timer: () => clockMs });
    // Coin Metrics (50 s) plus 6 Yahoo requests reach 350 s; the 7th starts at 350 s and ends at 400 s, then nothing.
    assert.equal(transport.calls.length, 8);
    const s = byId(res.session);
    assert.equal(s.btc.status, 'ok');
    assert.equal(s.gold.note, C.NOTE_YAHOO_DEADLINE);
    assert.equal(res.status, 'written');
    // Coin Metrics pages also stop at the deadline.
    const budget = C.makeBudget(() => clockMs, 1000);
    clockMs += 1000;
    assert.deepEqual(await C.fetchCoinMetrics(async () => assert.fail('no request'), noSleep, C.coinMetricsUrl(['btc'], WIN, ms(FINAL_NOW)), () => 0, budget),
      { error: C.NOTE_CM_DEADLINE });
  });
});

test('a run within 30 minutes of a run Yahoo refused outright sends Yahoo nothing (cross-run backoff)', async () => {
  await withDir(async (dir) => {
    const refusing = transportWith((url, y) => (y ? { status: 403, text: '' } : undefined));
    const first = await runAt(dir, kst('12:00'), { transport: refusing });
    assert.equal(refusing.yahoo().length, 1);
    assert.equal(C.yahooBackoff(first.session, ms(kst('12:15'))), true);
    assert.equal(C.yahooBackoff(first.session, ms(kst('12:30'))), false);

    const quietRun = transportWith();
    const lines = [];
    const second = await runAt(dir, kst('12:15'), { transport: quietRun, log: (l) => lines.push(l) });
    assert.equal(quietRun.yahoo().length, 0);
    assert.match(lines.join('\n'), /no Yahoo request until 30 minutes/);
    const s = byId(second.session);
    assert.deepEqual([s.kospi.status, s.kospi.note], ['error', C.NOTE_BACKOFF]);
    assert.equal(s.btc.status, 'ok');
    // The backoff note is not a refusal: the next run asks Yahoo again.
    const third = transportWith();
    const again = await runAt(dir, kst('12:30'), { transport: third });
    assert.ok(third.yahoo().length > 1);
    assert.equal(byId(again.session).kospi.status, 'ok');
  });
  // A partial refusal (some Yahoo series succeeded first) does not trigger the backoff.
  await withDir(async (dir) => {
    const late429 = transportWith((url, y) => (y && y.symbol === '^TWII' ? { status: 429, text: '' } : undefined));
    const res = await runAt(dir, kst('12:00'), { transport: late429 });
    assert.equal(C.yahooBackoff(res.session, ms(kst('12:15'))), false);
  });
});

test('Coin Metrics paging follows https same-host next_page_url only, at most 5 pages (tests-06 K23)', async () => {
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
  const plain = [];
  const httpNext = await C.fetchCoinMetrics(async (u) => {
    plain.push(u);
    return { status: 200, text: JSON.stringify({ data: [row(0)], next_page_url: url.replace('https:', 'http:') }) };
  }, noSleep, url, () => 0);
  assert.deepEqual([plain.length, httpNext.rows.length], [1, 1]);
  let count = 0;
  const endless = async () => ({ status: 200, text: JSON.stringify({ data: [row(++count % 60)], next_page_url: `${url}&p=${count}` }) });
  assert.equal((await C.fetchCoinMetrics(endless, noSleep, url, () => 0)).rows.length, 5);
  assert.deepEqual(await C.fetchCoinMetrics(async () => ({ status: 200, text: '{"error":1}' }), noSleep, url, () => 0), { error: 'Coin Metrics 응답 형식 오류' });
});

// ---------------------------------------------------------------- whole runs (fixtures, temporary directories)

test('CLI --fixtures writes a valid session and index; GITHUB_OUTPUT and ::warning lines report it (tests-08)', () => {
  const dir = tmpDir();
  try {
    const out = cli(['--date', DATE, '--fixtures', FIX, '--now', FINAL_NOW, '--data-dir', dir], dir);
    assert.equal(out.status, 0, out.stderr);
    assert.deepEqual(out.output, { date: DATE, final: 'true', status: 'written', written: DATE });
    assert.match(out.stdout, /^::warning title=parallel taiex::error: Yahoo HTTP 404$/m);
    assert.match(out.stdout, /^::warning title=parallel xmr::error: Coin Metrics 자료 없음 · Yahoo HTTP 404$/m);
    assert.doesNotMatch(out.stdout, /::warning title=parallel kospi::/);
    const file = sessionFile(dir);
    const text = fs.readFileSync(file, 'utf8');
    const session = Core.validateSession(JSON.parse(text));
    assert.match(text, /\n {8}\["2026-03-04T00:00:00Z", 2510\.2, 0\.388\],\n/);
    const s = byId(session);
    assert.equal(session.final, true);
    assert.equal(session.generatedAt, FINAL_NOW);
    assert.deepEqual([s.kospi.status, s.kospi.baseline], ['ok', { value: 2500.5, label: '3/3 종가' }]);
    assert.deepEqual(s.kospi.points[s.kospi.points.length - 1], [kst('15:30'), 2523.6, Core.pctChange(2523.6, 2500.5)]);
    assert.deepEqual(s.nikkei.baseline, { value: 38000, label: C.LABEL_PREV_CLOSE_FALLBACK });
    // Nikkei's 11:30 morning-close print stays at 11:30 (core SERIES breakKst).
    assert.ok(!s.nikkei.points.some((p) => p[0] === kst('11:45')));
    assert.deepEqual(s.nikkei.points.find((p) => p[0] === kst('11:30')).slice(0, 2), [kst('11:30'), barValue('_N225.intraday.json', 'close', '11:30')]);
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

    // The final file still has failed series: 30 minutes later it waits (repair-wait), 60 minutes later it is
    // collected again; the result differs only in fetch times, so nothing is written (security-4).
    const indexText = fs.readFileSync(path.join(dir, 'index.json'), 'utf8');
    const wait = cli(['--date', DATE, '--fixtures', FIX, '--now', '2026-03-04T08:00:00Z', '--data-dir', dir], dir);
    assert.equal(wait.status, 0, wait.stderr);
    assert.deepEqual(wait.output, { date: DATE, final: 'true', status: 'skipped', written: '' });
    assert.match(wait.stdout, /less than 60 minutes ago; skipping/);
    const again = cli(['--date', DATE, '--fixtures', FIX, '--now', '2026-03-04T08:30:00Z', '--data-dir', dir], dir);
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /^Collecting 2026-03-04/);
    assert.match(again.stdout, /nothing changed since 2026-03-04T07:30:00Z/);
    assert.deepEqual(again.output, { date: DATE, final: 'true', status: 'unchanged', written: '' });
    assert.match(again.stdout, /^::warning title=parallel taiex::error: Yahoo HTTP 404$/m);
    assert.equal(fs.readFileSync(file, 'utf8'), text);
    assert.equal(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'), indexText);
    const dry = spawnSync(process.execPath, [SCRIPT, '--date', DATE, '--fixtures', FIX, '--now', '2026-03-04T09:30:00Z', '--data-dir', dir, '--force', '--dry-run'], { encoding: 'utf8' });
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, /Dry run/);
    assert.equal(fs.readFileSync(file, 'utf8'), text);
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
    const runOnce = async (iso, transport, extra = {}) => {
      const calls = [];
      const sleeps = [];
      const res = await C.run({ date: DATE, now: iso, dataDir: dir, sleep: async (n) => { sleeps.push(n); }, log: quiet, ...extra,
        transport: async (url) => { calls.push(url); return transport(url); } });
      return { res, calls, sleeps };
    };
    let first = true;
    const one = await runOnce('2026-03-04T05:00:00Z', (url) => {
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

    // --throttle (push-triggered runs) skips a session collected less than 10 minutes ago.
    const throttled = await runOnce('2026-03-04T05:05:00Z', fixtures, { throttle: true });
    assert.deepEqual([throttled.res.status, throttled.res.reason, throttled.calls.length], ['skipped', 'throttled', 0]);

    const two = await runOnce('2026-03-04T05:15:00Z', async (url) => {
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

    const three = await runOnce('2026-03-04T05:30:00Z', fixtures);
    const s3 = byId(three.res.session);
    assert.equal(s3.kospi.status, 'ok');
    assert.equal(three.calls.filter((u) => u.includes('/%5EKS11?interval=1d')).length, 0);
    assert.deepEqual(s3.kospi.baseline, { value: 2500.5, label: '3/3 종가' });
    assert.deepEqual(validateDataDir(dir).errors, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an empty or truncated 200 answer on the finalizing run keeps the stored points as stale and is repaired later (tests-02)', async () => {
  for (const variant of ['empty', 'truncated']) {
    await withDir(async (dir) => {
      const first = await runAt(dir, kst('14:00'));
      const k1 = byId(first.session).kospi;
      assert.deepEqual([k1.status, k1.points.length, k1.points[k1.points.length - 1][0]], ['ok', 21, kst('14:00')]);
      const glitch = transportWith((url, y) => {
        if (!y || y.symbol !== '^KS11' || y.daily) return undefined;
        return variant === 'empty' ? metaOnlyAnswer('_KS11.intraday.json') : truncatedAnswer('_KS11.intraday.json', kst('12:00'));
      });
      const fin = await runAt(dir, kst('16:22'), { transport: glitch });
      const k2 = byId(fin.session).kospi;
      assert.equal(fin.final, true);
      assert.equal(k2.status, 'stale', variant);
      if (variant === 'empty') {
        assert.deepEqual([k2.note, k2.points, k2.fetchedAt], [C.NOTE_KEPT_EMPTY, k1.points, k1.fetchedAt]);
      } else {
        // 09:00..12:00 from the new answer, the stored 12:15..14:00 merged in; nothing lost.
        assert.equal(k2.note, C.NOTE_KEPT_PARTIAL);
        assert.deepEqual(k2.points, k1.points);
      }
      assert.ok(!k2.note.includes(C.NOTE_NO_DATA));
      assert.equal(readJson(path.join(dir, 'index.json')).sessions[0].seriesWithData, 7);
      // The catch-up run retries the stale series once the file is 60 minutes old and restores it.
      assert.equal((await runAt(dir, kst('17:17'))).reason, 'repair-wait');
      const repaired = await runAt(dir, kst('17:22'));
      const k3 = byId(repaired.session).kospi;
      assert.deepEqual([repaired.status, k3.status, k3.note, k3.points.length], ['written', 'ok', '', 26]);
      assert.deepEqual(k3.points[k3.points.length - 1], [kst('15:30'), 2523.6, Core.pctChange(2523.6, 2500.5)]);
      assert.deepEqual(validateDataDir(dir).errors, []);
    });
  }
});

test('a forced re-collection of a final session never wipes it; another window needs --replace-window (security-1)', async () => {
  await withDir(async (dir) => {
    await runAt(dir, FINAL_NOW, { transport: completeTransport() });
    const before = readJson(sessionFile(dir));
    const kospi = (s) => byId(s).kospi;
    // Forced, the next day, while ^KS11 answers 200 without bars.
    const empty = transportWith((url, y) => (y && y.symbol === '^KS11' && !y.daily ? metaOnlyAnswer('_KS11.intraday.json') : undefined), completeTransport());
    const forced = await runAt(dir, '2026-03-05T02:00:00Z', { transport: empty, force: true });
    assert.deepEqual([kospi(forced.session).status, kospi(forced.session).points], ['stale', kospi(before).points]);
    assert.deepEqual(readJson(path.join(dir, 'index.json')).sessions[0].seriesWithData, 19);

    // A different window is refused without --replace-window (nothing is requested or written).
    const counting = transportWith(null, completeTransport());
    const stored = fs.readFileSync(sessionFile(dir), 'utf8');
    await assert.rejects(runAt(dir, '2026-03-05T02:00:00Z', { start: '09:00', end: '15:30', force: true, transport: counting }),
      (error) => error instanceof C.UsageError && /--replace-window/.test(error.message));
    assert.equal(counting.calls.length, 0);
    assert.equal(fs.readFileSync(sessionFile(dir), 'utf8'), stored);
    const refused = cli(['--date', DATE, '--start', '09:00', '--fixtures', FIX, '--now', '2026-03-05T02:00:00Z', '--data-dir', dir], dir);
    assert.equal(refused.status, 2);
    assert.match(refused.stderr, /stored session covers 08:00~16:00 KST, not 09:00~16:00 KST/);
    // The same window spelled out is fine (and restores KOSPI); --replace-window replaces the window.
    const spelled = await runAt(dir, '2026-03-05T02:00:00Z', { start: '08:00', end: '16:00', force: true, transport: completeTransport() });
    assert.deepEqual([spelled.status, kospi(spelled.session).status, kospi(spelled.session).points], ['written', 'ok', kospi(before).points]);
    const replaced = await runAt(dir, '2026-03-05T02:00:00Z', { start: '09:00', end: '15:30', replaceWindow: true, force: true, transport: completeTransport() });
    assert.deepEqual(replaced.session.window, Core.sessionWindow(DATE, '09:00', '15:30'));
    assert.deepEqual(validateDataDir(dir).errors, []);
    assert.throws(() => C.parseArgs(['--replace-window']), /--start or --end/);
  });
});

test('an unattended run keeps the stored window of a session collected with a custom window', async () => {
  await withDir(async (dir) => {
    const custom = await runAt(dir, kst('12:00'), { start: '08:00', end: '17:00' });
    assert.equal(custom.session.window.end, kst('17:00'));
    const res = await C.run({ now: kst('12:30'), dataDir: dir, transport: C.fixtureTransport(FIX), sleep: noSleep, log: quiet });
    assert.deepEqual([res.status, res.date, res.session.window.end], ['written', DATE, kst('17:00')]);
  });
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

test('carry-over rules: stale keeps the source it came from, a missing previous close is a failure, a cached close survives (tests-06)', async () => {
  // K11: HYPE came from the Yahoo fallback; when both providers fail, the kept points keep the Yahoo source.
  await withDir(async (dir) => {
    const cmDown = transportWith((url, y) => (y ? undefined : { status: 503, text: '' }));
    const one = byId((await runAt(dir, kst('12:00'), { transport: cmDown })).session);
    assert.deepEqual([one.hype.status, one.hype.source], ['ok', { provider: 'yahoo', symbol: 'HYPE32196-USD' }]);
    const allDown = transportWith((url, y) => (!y || y.symbol === 'HYPE32196-USD' ? { status: 503, text: '' } : undefined));
    const two = byId((await runAt(dir, kst('12:15'), { transport: allDown })).session);
    assert.deepEqual([two.hype.status, two.hype.source, two.hype.points], ['stale', { provider: 'yahoo', symbol: 'HYPE32196-USD' }, one.hype.points]);
    assert.equal(two.hype.note, 'Coin Metrics HTTP 503 · Yahoo HTTP 503');
  });
  // K40: points but no previous close (daily 503, no meta.chartPreviousClose) is a failure, never 'missing'.
  await withDir(async (dir) => {
    const noClose = transportWith((url, y) => {
      if (!y || y.symbol !== '^KS11') return undefined;
      if (y.daily) return { status: 503, text: '' };
      const j = fixture('_KS11.intraday.json');
      delete j.chart.result[0].meta.chartPreviousClose;
      return ok(j);
    });
    const k = byId((await runAt(dir, kst('12:00'), { transport: noClose })).session).kospi;
    assert.deepEqual([k.status, k.note, k.points], ['error', '전일 종가 확인 실패', []]);
  });
  // K10: a cached previous close (series still without points) survives a failed request.
  await withDir(async (dir) => {
    const pre = byId((await runAt(dir, kst('08:30'))).session).kospi;
    assert.deepEqual([pre.status, pre.baseline, pre.points], ['missing', { value: 2500.5, label: '3/3 종가' }, []]);
    const down = transportWith((url, y) => (y && y.symbol === '^KS11' ? { status: 503, text: '' } : undefined));
    const k = byId((await runAt(dir, kst('08:45'), { transport: down })).session).kospi;
    assert.deepEqual([k.status, k.note, k.baseline, k.points], ['error', 'Yahoo HTTP 503', { value: 2500.5, label: '3/3 종가' }, []]);
  });
});

test('weekends are skipped unless --date is given; a future date is refused; nothing is written before the window starts (data-04)', async () => {
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

    // A date after today's KST date is a usage error: no request, no file.
    calls.length = 0;
    await assert.rejects(C.run({ date: '2026-03-09', now: '2026-03-08T12:00:00Z', dataDir: dir, transport, sleep: noSleep, log: quiet }),
      (error) => error instanceof C.UsageError && /later than today \(2026-03-08 KST\)/.test(error.message));
    // Today before the window start: skipped, nothing written.
    const early = await C.run({ date: '2026-03-09', now: '2026-03-08T22:30:00Z', dataDir: dir, transport, sleep: noSleep, log: quiet });
    assert.deepEqual([early.status, early.reason, early.final, calls.length], ['skipped', 'not-started', false, 0]);
    assert.equal(fs.existsSync(sessionFile(dir, '2026-03-09')), false);
    const index = readJson(path.join(dir, 'index.json'));
    assert.deepEqual(index.sessions.map((e) => e.date), ['2026-03-07']);
    assert.deepEqual(validateDataDir(dir).errors, []);
    const cliFuture = spawnSync(process.execPath, [SCRIPT, '--date', '2026-12-04', '--now', '2026-11-04T05:00:00Z', '--fixtures', FIX, '--data-dir', dir], { encoding: 'utf8' });
    assert.equal(cliFuture.status, 2);
    assert.match(cliFuture.stderr, /--date 2026-12-04 is later than today/);
    assert.equal(fs.existsSync(sessionFile(dir, '2026-12-04')), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an unattended run also finalizes earlier sessions left non-final, newest first, at most 5 (security-2)', async () => {
  // A 14:00 KST file for 3/4 and no post-close run: the Saturday run (weekend) finalizes it.
  await withDir(async (dir) => {
    await runAt(dir, kst('14:00'));
    assert.equal(readJson(sessionFile(dir)).final, false);
    const sat = await C.run({ now: '2026-03-07T03:00:00Z', dataDir: dir, transport: C.fixtureTransport(FIX), sleep: noSleep, log: quiet });
    assert.deepEqual([sat.status, sat.reason], ['skipped', 'weekend']);
    assert.deepEqual(sat.backlog.map((r) => [r.date, r.status, r.final]), [[DATE, 'written', true]]);
    assert.equal(readJson(sessionFile(dir)).final, true);
    assert.equal(readJson(path.join(dir, 'index.json')).sessions[0].final, true);
    const out = cli(['--fixtures', FIX, '--now', '2026-03-07T04:00:00Z', '--data-dir', dir], dir);
    assert.deepEqual(out.output, { date: '2026-03-07', final: 'false', status: 'skipped', written: '' });
  });
  // Six non-final sessions: the newest five are collected (all finalized), the oldest waits; --date never does this.
  await withDir(async (dir) => {
    const dates = ['2026-02-24', '2026-02-25', '2026-02-26', '2026-02-27', '2026-03-02', '2026-03-03'];
    for (const date of dates) {
      const win = Core.sessionWindow(date);
      const s = C.buildSession({ date, window: win, nowMs: ms(win.start) + 3600e3, results: [] });
      fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true });
      fs.writeFileSync(sessionFile(dir, date), C.serializeJson(s));
    }
    const viaDate = await runAt(dir, kst('12:00'));
    assert.deepEqual(viaDate.backlog, []);
    const res = await C.run({ now: kst('12:30'), dataDir: dir, transport: C.fixtureTransport(FIX), sleep: noSleep, log: quiet });
    assert.equal(res.date, DATE);
    assert.deepEqual(res.backlog.map((r) => [r.date, r.status, r.final]),
      dates.slice(1).reverse().map((d) => [d, 'written', true]));
    assert.equal(readJson(sessionFile(dir, '2026-02-24')).final, false);
    assert.deepEqual(validateDataDir(dir).errors, []);
  });
  // Yahoo refusing: the backlog waits (it is not finalized with stale data), here and when the refusal comes mid-way.
  await withDir(async (dir) => {
    await runAt(dir, kst('14:00'));
    const text = fs.readFileSync(sessionFile(dir), 'utf8');
    const refusing = transportWith((url, y) => (y ? { status: 429, text: '' } : undefined));
    const sat = await C.run({ now: '2026-03-07T03:00:00Z', dataDir: dir, transport: refusing, sleep: noSleep, log: quiet });
    assert.deepEqual(sat.backlog.map((r) => [r.status, r.reason]), [['skipped', 'provider-stopped']]);
    assert.equal(fs.readFileSync(sessionFile(dir), 'utf8'), text);
    const mon = await C.run({ now: '2026-03-09T01:00:00Z', dataDir: dir, transport: refusing, sleep: noSleep, log: quiet });
    assert.deepEqual([mon.date, mon.status, mon.backlog], ['2026-03-09', 'written', []]);
    assert.equal(readJson(sessionFile(dir)).final, false);
  });
});

test('parseArgs accepts the documented options and rejects malformed values', () => {
  assert.deepEqual(C.parseArgs(['--date=2026-03-04', '--start', '07:30', '--end', '18:00', '--force', '--dry-run', '--now', FINAL_NOW,
    '--data-dir', 'out', '--fixtures', 'fx', '--overlay-dir', 'branch', '--throttle', '--replace-window']),
  { date: '2026-03-04', start: '07:30', end: '18:00', dataDir: 'out', overlayDir: 'branch', now: FINAL_NOW, fixtures: 'fx',
    force: true, dryRun: true, throttle: true, replaceWindow: true, rebuildIndex: false });
  assert.equal(C.parseArgs(['--date', '']).date, null);
  assert.deepEqual(C.parseArgs(['--rebuild-index', '--data-dir', 'x']).rebuildIndex, true);
  for (const bad of [['--date', '2026-02-30'], ['--date', '20260304'], ['--start', '8:00'], ['--end', '25:00'], ['--now', 'soon'],
    ['--date'], ['--frobnicate'], ['--force=yes'], ['--throttle=1'], ['--rebuild-index', '--date', '2026-03-04'],
    ['--rebuild-index', '--force'], ['--rebuild-index', '--overlay-dir', 'x'], ['--replace-window', '--date', '2026-03-04']]) {
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
    const sessionText = fs.readFileSync(sessionFile(dir), 'utf8');
    fs.mkdirSync(path.join(dir, 'notes'));
    fs.writeFileSync(path.join(dir, 'notes', `${DATE}.json`), JSON.stringify({ schemaVersion: 3, kind: 'notes', date: DATE, title: '합성 노트' }));
    assert.match(validateDataDir(dir).warnings.join('\n'), /does not list yet/);
    const res = await C.run({ date: DATE, now: '2026-03-04T09:00:00Z', dataDir: dir, transport: counting, sleep: noSleep, log: quiet });
    assert.deepEqual([res.status, res.reason, res.indexWritten, calls], ['skipped', 'final', true, 0]);
    assert.equal(fs.readFileSync(sessionFile(dir), 'utf8'), sessionText);
    const entry = readJson(path.join(dir, 'index.json')).sessions[0];
    assert.deepEqual([entry.title, entry.hasNotes, entry.updatedAt], ['합성 노트', true, FINAL_NOW]);
    const res2 = await C.run({ date: DATE, now: '2026-03-04T10:00:00Z', dataDir: dir, transport: counting, sleep: noSleep, log: quiet });
    assert.deepEqual([res2.indexWritten, calls], [false, 0]);
    const check = validateDataDir(dir);
    assert.deepEqual([check.errors, check.warnings], [[], []]);
    // A forced run whose answers are identical writes nothing either.
    const forced = await C.run({ date: DATE, now: '2026-03-04T11:00:00Z', dataDir: dir, transport: completeTransport(), sleep: noSleep, log: quiet, force: true });
    assert.deepEqual([forced.status, forced.indexWritten], ['unchanged', false]);
    assert.equal(fs.readFileSync(sessionFile(dir), 'utf8'), sessionText);
    assert.equal(C.sameSessionContent(readJson(sessionFile(dir)), { ...readJson(sessionFile(dir)), generatedAt: '2027-01-01T00:00:00Z' }), true);
    assert.equal(C.sameSessionContent(readJson(sessionFile(dir)), { ...readJson(sessionFile(dir)), final: false }), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('--overlay-dir: newer data-branch sessions replace older copies before collecting; notes never come from it', async () => {
  await withDir(async (root) => {
    const main = path.join(root, 'main');
    const branch = path.join(root, 'branch');
    // The data branch has the live 3/4 session (13:00 KST); main has nothing yet.
    await runAt(branch, kst('13:00'));
    fs.mkdirSync(path.join(branch, 'notes'), { recursive: true });
    fs.writeFileSync(path.join(branch, 'notes', `${DATE}.json`), JSON.stringify({ schemaVersion: 3, kind: 'notes', date: DATE, title: '오버레이 노트' }));
    // A dated but invalid session (no window, no series) on the branch is ignored, never copied.
    fs.writeFileSync(path.join(branch, 'sessions', '2026-03-03.json'), '{"schemaVersion": 3, "kind": "session", "date": "2026-03-03"}');
    const branchText = fs.readFileSync(sessionFile(branch), 'utf8');

    // Dry run: the overlay copy is used as the previous file (no daily request for KOSPI's cached close) but not copied.
    const dryCalls = transportWith();
    const lines = [];
    const dry = await runAt(main, kst('13:30'), { overlayDir: branch, dryRun: true, transport: dryCalls, log: (l) => lines.push(l) });
    assert.equal(dry.status, 'dry-run');
    assert.ok(!dryCalls.calls.some((u) => u.includes('/%5EKS11?interval=1d')));
    assert.equal(fs.existsSync(sessionFile(main)), false);
    assert.match(lines.join('\n'), /warning: ignoring overlay sessions\/2026-03-03\.json/);

    const calls = transportWith();
    const res = await runAt(main, kst('13:30'), { overlayDir: branch, transport: calls });
    assert.deepEqual([res.status, res.overlay], ['written', [DATE]]);
    assert.ok(!calls.calls.some((u) => u.includes('/%5EKS11?interval=1d')));
    const index = readJson(path.join(main, 'index.json'));
    assert.deepEqual([index.sessions.length, index.sessions[0].title, index.sessions[0].hasNotes], [1, null, false]);
    assert.equal(fs.readFileSync(sessionFile(branch), 'utf8'), branchText); // the overlay is only read
    assert.equal(fs.existsSync(sessionFile(main, '2026-03-03')), false);
    assert.deepEqual(validateDataDir(main).errors, []);

    // An overlay copy that is not newer is ignored.
    const later = await runAt(main, kst('14:00'), { overlayDir: branch });
    assert.deepEqual(later.overlay, []);
    assert.equal(readJson(sessionFile(main)).generatedAt, kst('14:00'));
    // A newer overlay copy of a date that is not collected is still copied, so the index lists it.
    const other = path.join(root, 'other');
    await runAt(other, '2026-03-04T07:30:00Z');
    const r = await C.run({ date: '2026-03-07', now: '2026-03-07T03:00:00Z', overlayDir: other, dataDir: main,
      transport: C.fixtureTransport(FIX), sleep: noSleep, log: quiet });
    assert.deepEqual(r.overlay, [DATE]);
    assert.equal(readJson(sessionFile(main)).generatedAt, '2026-03-04T07:30:00Z');
    assert.deepEqual(readJson(path.join(main, 'index.json')).sessions.map((e) => [e.date, e.final]), [['2026-03-07', false], [DATE, true]]);
    assert.deepEqual(validateDataDir(main).errors, []);
    // A missing overlay directory (first run, no data branch yet) is fine.
    assert.equal((await runAt(main, kst('15:00'), { overlayDir: path.join(root, 'none') })).overlay.length, 0);
  });
});

test('--rebuild-index rebuilds index.json from the session and notes files only (no requests)', async () => {
  await withDir(async (dir) => {
    await runAt(dir, FINAL_NOW);
    await runAt(dir, '2026-03-07T03:00:00Z', { date: '2026-03-07' });
    fs.mkdirSync(path.join(dir, 'notes'));
    fs.writeFileSync(path.join(dir, 'notes', `${DATE}.json`), JSON.stringify({ schemaVersion: 3, kind: 'notes', date: DATE, title: '노트 제목' }));
    fs.rmSync(path.join(dir, 'index.json'));
    const res = await C.run({ rebuildIndex: true, dataDir: dir, log: quiet, transport: async () => assert.fail('no request') });
    assert.equal(res.status, 'index-written');
    const index = readJson(path.join(dir, 'index.json'));
    assert.equal(index.updatedAt, '2026-03-07T03:00:00Z'); // the newest session's generatedAt, not the clock
    assert.deepEqual(index.sessions.map((e) => [e.date, e.title, e.hasNotes]), [['2026-03-07', null, false], [DATE, '노트 제목', true]]);
    assert.deepEqual(validateDataDir(dir).errors, []);
    const text = fs.readFileSync(path.join(dir, 'index.json'), 'utf8');
    assert.equal((await C.run({ rebuildIndex: true, dataDir: dir, log: quiet })).status, 'index-unchanged');
    // A session removed from the directory leaves the index.
    fs.rmSync(sessionFile(dir, '2026-03-07'));
    const out = spawnSync(process.execPath, [SCRIPT, '--rebuild-index', '--data-dir', dir], { encoding: 'utf8' });
    assert.equal(out.status, 0, out.stderr);
    assert.notEqual(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'), text);
    assert.deepEqual(readJson(path.join(dir, 'index.json')).sessions.map((e) => e.date), [DATE]);
    const bad = spawnSync(process.execPath, [SCRIPT, '--rebuild-index', '--date', DATE, '--data-dir', dir], { encoding: 'utf8' });
    assert.equal(bad.status, 2);
  });
});

// ---------------------------------------------------------------- validator

test('validate-parallel: the index must list exactly the session files and agree on final', async () => {
  const dir = tmpDir();
  try {
    assert.deepEqual(validateDataDir(dir).errors, []); // nothing collected yet
    await C.run({ date: DATE, now: FINAL_NOW, dataDir: dir, transport: C.fixtureTransport(FIX), sleep: noSleep, log: quiet });
    const indexFile = path.join(dir, 'index.json');
    const file = sessionFile(dir);
    const index = readJson(indexFile);
    const write = (f, obj) => fs.writeFileSync(f, `${JSON.stringify(obj)}\n`);

    write(indexFile, { ...index, sessions: [] });
    assert.match(validateDataDir(dir).errors.join('\n'), /sessions\/2026-03-04\.json is not listed/);
    const cliRun = spawnSync(process.execPath, [VALIDATOR, dir], { encoding: 'utf8' });
    assert.equal(cliRun.status, 1);
    assert.match(cliRun.stderr, /not listed/);

    write(indexFile, { ...index, sessions: [...index.sessions, { ...index.sessions[0], date: '2026-03-03' }] });
    assert.match(validateDataDir(dir).errors.join('\n'), /2026-03-03 is listed but sessions\/2026-03-03\.json does not exist/);

    write(indexFile, { ...index, sessions: [{ ...index.sessions[0], final: false }] });
    assert.match(validateDataDir(dir).errors.join('\n'), /final is false but the session file says true/);

    write(indexFile, index);
    fs.copyFileSync(file, path.join(dir, 'sessions', '2026-03-05.json'));
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

    const session = readJson(file);
    session.series[0].points[0][2] += 1;
    write(file, session);
    assert.match(validateDataDir(dir).errors.join('\n'), /sessions\/2026-03-04\.json: session\.series\[0\]\.points\[0\]\[2\]/);
    fs.rmSync(indexFile);
    assert.match(validateDataDir(dir).errors.join('\n'), /index\.json: missing/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
