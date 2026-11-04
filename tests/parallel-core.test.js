'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const C = require('../parallel-core.js');

const DATE = '2026-11-04';
const MIN = 60000;
const iso = (hhmm) => C.kstToUtcIso(DATE, hhmm);
const at = (hhmm) => Date.parse(iso(hhmm));
const clone = (v) => JSON.parse(JSON.stringify(v));

// Optional cross-check against an independently computed truth table (never stored in the repo).
// Set PARALLEL_TRUTH_FILE to run it; the committed sessions are covered by `npm run validate`.
const TRUTH_FILE = process.env.PARALLEL_TRUTH_FILE || '';

// Piecewise-linear pct path sampled every 15 minutes from the first to the last anchor.
function path(anchors) {
  const knots = anchors.map(([hhmm, p]) => [at(hhmm), p]);
  const out = [];
  for (let t = knots[0][0], k = 0; t <= knots[knots.length - 1][0]; t += 15 * MIN) {
    while (k < knots.length - 2 && t > knots[k + 1][0]) k += 1;
    const [t0, p0] = knots[k];
    const [t1, p1] = knots[Math.min(k + 1, knots.length - 1)];
    const p = t1 === t0 ? p1 : p0 + ((p1 - p0) * (t - t0)) / (t1 - t0);
    out.push([t, Math.round(p * 1000) / 1000]);
  }
  return out;
}

function series(id, anchors) {
  const d = C.SERIES.find((s) => s.id === id);
  const base = 1000;
  return {
    id, panel: d.panel, label: d.label, basis: d.basis,
    baseline: { value: base, label: d.basis === 'prevClose' ? '11/3 종가' : '08:00 KST' },
    source: clone(d.sources[0]), status: 'ok', note: '', fetchedAt: '2026-11-04T07:20:00Z',
    points: path(anchors).map(([t, p]) => [C.isoUtc(t), Number((base * (1 + p / 100)).toFixed(6)), p]),
  };
}

// Four panels; kospi, skhynix and btc bottom at 12:45 and jump between 13:15 and 13:30.
function syntheticSession() {
  return {
    schemaVersion: 3, kind: 'session', date: DATE, timezone: 'Asia/Seoul',
    window: C.sessionWindow(DATE), intervalMinutes: 15, generatedAt: '2026-11-04T07:25:00Z', final: true,
    series: [
      series('kospi', [['09:00', 1.0], ['12:45', -3.0], ['13:00', -2.95], ['13:15', -2.9], ['13:30', -1.0], ['13:45', -1.0], ['15:30', 0.5]]),
      series('hsi', [['10:30', 0.2], ['11:00', -0.2], ['12:45', 0.3], ['15:30', 1.0], ['16:00', 1.0]]),
      series('skhynix', [['09:00', 2.0], ['12:45', -5.0], ['13:00', -4.95], ['13:15', -4.9], ['13:30', -2.0], ['13:45', -2.0], ['15:30', -1.0]]),
      series('btc', [['08:00', 0], ['12:45', -2.0], ['13:00', -1.95], ['13:15', -1.9], ['13:30', -0.6], ['13:45', -0.6], ['16:00', 0.1]]),
      series('eth', [['08:00', 0], ['10:00', -1.2], ['12:45', -0.9], ['13:15', -0.9], ['13:30', -0.5], ['13:45', -0.5], ['16:00', -0.3]]),
      series('gold', [['08:00', 0], ['14:30', 0.2], ['15:30', 1.7], ['16:00', 1.8]]),
      series('usdkrw', [['08:00', 0], ['11:00', -0.4], ['16:00', -0.3]]),
    ],
    providers: clone(C.PROVIDERS),
  };
}

function syntheticNotes() {
  return {
    schemaVersion: 3, kind: 'notes', date: DATE,
    events: [
      { id: 'house', at: iso('12:15'), label: '하원 투영', kind: 'projection' },
      { id: 'tx', at: iso('12:55'), label: 'TX', kind: 'call' },
      { id: 'oh', at: iso('13:11'), label: 'OH', kind: 'call' },
      { id: 'senate', at: iso('13:22'), end: iso('13:37'), label: '상원 확정', sub: '트럼프 승복', kind: 'band' },
    ],
  };
}

const pts = (list) => list.map(([hhmm, p]) => ({ t: at(hhmm), v: 100 + p, p }));

// assert.throws matches a RegExp against String(error) ("Error: ..."), so match the message itself.
function throwsMessage(fn, pattern, name) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof Error, name);
    assert.match(error.message, pattern, name);
    return true;
  }, name);
}
const sv = (list) => ({ points: list.map(([hhmm, p]) => [iso(hhmm), 100 * (1 + p / 100), p]) });

// ------------------------------------------------------------------ constants

test('catalog constants follow the spec order and stay frozen', () => {
  assert.deepEqual(C.PANELS.map((p) => p.key), ['indices', 'ai', 'crypto', 'fx']);
  assert.deepEqual(C.PANELS.map((p) => p.label), ['주식지수', 'AI·반도체 종목', '크립토', '달러·금']);
  assert.deepEqual(C.PANELS.map((p) => p.suffix), ['(전일 종가 대비 %)', '(전일 종가 대비 %)', '(08:00 KST 대비 %)', '(08:00 KST 대비 %)']);
  assert.deepEqual(C.SERIES.map((s) => s.id), ['kospi', 'nikkei', 'taiex', 'hsi', 'nq', 'skhynix', 'samsung', 'tsmc', 'softbank',
    'advantest', 'btc', 'eth', 'hype', 'zec', 'xmr', 'dxy', 'usdkrw', 'usdjpy', 'gold']);
  for (const p of C.PANELS) assert.ok(C.SERIES.filter((s) => s.panel === p.key).length <= C.COLORS.light.length);
  const kospi = C.SERIES[0];
  assert.deepEqual(kospi, { id: 'kospi', panel: 'indices', label: '코스피', basis: 'prevClose',
    sources: [{ provider: 'yahoo', symbol: '^KS11' }], closeKst: '15:30' });
  assert.deepEqual(C.SERIES.find((s) => s.id === 'hype').sources,
    [{ provider: 'coinmetrics', symbol: 'hype' }, { provider: 'yahoo', symbol: 'HYPE32196-USD' }]);
  assert.equal(C.SERIES.find((s) => s.id === 'nq').closeKst, null);
  assert.equal(C.SERIES.find((s) => s.id === 'taiex').closeKst, '14:30');
  assert.equal(C.SERIES.find((s) => s.id === 'hsi').closeKst, '17:10');
  assert.equal(C.COLORS.light.length, 5);
  assert.equal(C.COLORS.dark[0], '#6aa6f5');
  assert.deepEqual(C.PROVIDERS.map((p) => p.id), ['yahoo', 'coinmetrics']);
  assert.equal(C.PROVIDERS[1].license, 'CC BY-NC 4.0');
  assert.equal(C.KST_OFFSET_MS, 9 * 3600e3);
  assert.ok(Object.isFrozen(C.SERIES) && Object.isFrozen(C.SERIES[0].sources[0]) && Object.isFrozen(C.PROVIDERS[0]));
  assert.throws(() => { C.SERIES[0].label = 'x'; }, TypeError);
});

// ------------------------------------------------------------------ time

test('KST helpers convert between KST wall clock and UTC', () => {
  assert.equal(C.kstToUtcIso('2026-11-04', '08:00'), '2026-11-03T23:00:00Z');
  assert.equal(C.kstToUtcIso('2026-11-04', '16:00'), '2026-11-04T07:00:00Z');
  assert.equal(C.kstToUtcIso('2027-01-01', '00:00'), '2026-12-31T15:00:00Z');
  assert.equal(C.kstToUtcIso('2026-11-04', '24:00'), '2026-11-04T15:00:00Z');
  assert.equal(C.kstDate('2026-11-03T23:00:00Z'), '2026-11-04');
  assert.equal(C.kstDate('2026-11-04T14:59:59Z'), '2026-11-04');
  assert.equal(C.kstDate('2026-11-04T15:00:00Z'), '2026-11-05');
  assert.equal(C.kstTime('2026-11-03T23:00:00Z'), '08:00');
  assert.equal(C.kstTime(Date.parse('2026-11-04T02:36:59Z')), '11:36');
  assert.equal(C.kstDate(Date.parse('2026-11-04T00:00:00Z')), '2026-11-04');
  assert.deepEqual(C.sessionWindow('2026-11-04'), { start: '2026-11-03T23:00:00Z', end: '2026-11-04T07:00:00Z' });
  assert.deepEqual(C.sessionWindow('2026-11-04', '09:00', '15:30'), { start: '2026-11-04T00:00:00Z', end: '2026-11-04T06:30:00Z' });
  assert.equal(C.isoUtc(Date.parse('2026-11-04T00:15:00.000000000Z')), '2026-11-04T00:15:00Z');
  for (const bad of [['2026-02-30', '08:00'], ['2026-11-4', '08:00'], ['2026-11-04', '8:00'], ['2026-11-04', '25:00'],
    ['2026-11-04', '24:30'], ['2026-11-04', '12:60'], [null, '08:00']]) {
    assert.throws(() => C.kstToUtcIso(bad[0], bad[1]), TypeError, JSON.stringify(bad));
  }
  assert.throws(() => C.sessionWindow('2026-11-04', '16:00', '08:00'), RangeError);
  assert.throws(() => C.kstTime('not a time'), TypeError);
});

// ------------------------------------------------------------------ formatting

test('formatPct rounds half away from zero and uses a true minus sign', () => {
  assert.equal(C.formatPct(-0.04), '0.0%');
  assert.equal(C.formatPct(0.04), '0.0%');
  assert.equal(C.formatPct(0), '0.0%');
  assert.equal(C.formatPct(-0), '0.0%');
  assert.equal(C.formatPct(0.05), '+0.1%');
  assert.equal(C.formatPct(-0.05), '−0.1%');
  assert.equal(C.formatPct(1.25), '+1.3%');
  assert.equal(C.formatPct(-1.25), '−1.3%');
  assert.equal(C.formatPct(-3.934), '−3.9%');
  assert.ok(!C.formatPct(-3.934).includes('-'), 'hyphen-minus must not be used');
  assert.equal(C.formatPct(2.432, 2), '+2.43%');
  assert.equal(C.formatPct(1.005, 2), '+1.01%');
  assert.equal(C.formatPct(12.5, 0), '+13%');
  assert.equal(C.formatPct(NaN), '–');
  assert.equal(C.formatPct(null), '–');
  assert.equal(C.formatSignedPp(1.234), '+1.2p');
  assert.equal(C.formatSignedPp(-0.44), '−0.4p');
  assert.equal(C.formatSignedPp(0.04), '0.0p');
  assert.equal(C.formatSignedPp(0.966, 2), '+0.97p');
});

test('formatValue groups thousands and keeps 2 decimals or 4 significant digits', () => {
  assert.equal(C.formatValue(5648.79), '5,648.79');
  assert.equal(C.formatValue(63081.859375), '63,081.86');
  assert.equal(C.formatValue(1398000), '1,398,000');
  assert.equal(C.formatValue(77786.4), '77,786.4');
  assert.equal(C.formatValue(4037.300048828125), '4,037.3');
  assert.equal(C.formatValue(2295), '2,295');
  assert.equal(C.formatValue(101.885), '101.89');
  assert.equal(C.formatValue(85.6), '85.60');
  assert.equal(C.formatValue(1), '1.00');
  assert.equal(C.formatValue(0.5), '0.5000');
  assert.equal(C.formatValue(0.012345), '0.01235');
  assert.equal(C.formatValue(-1234.5), '−1,234.5');
  assert.equal(C.formatValue(Infinity), '–');
  assert.equal(C.pctChange(5786.1298828125, 5648.7900390625), 2.431);
  assert.equal(C.pctChange(1000, 1000), 0);
  assert.ok(Number.isNaN(C.pctChange(1, 0)));
});

// ------------------------------------------------------------------ axis & labels

function checkTicks(min, max, maxTicks, result) {
  const { ticks, step } = result;
  assert.ok(ticks.length >= 2 && ticks.length <= (maxTicks || 6), `tick count ${ticks.length}`);
  assert.ok(ticks[0] <= Math.min(min, max) && ticks[ticks.length - 1] >= Math.max(min, max), 'ticks cover the range');
  if (Math.min(min, max) <= 0 && Math.max(min, max) >= 0) assert.ok(ticks.includes(0), 'zero is a tick');
  const mantissa = step / Math.pow(10, Math.floor(Math.log10(step)));
  assert.ok([1, 2, 2.5, 5].some((m) => Math.abs(m - mantissa) < 1e-9), `nice step ${step}`);
  for (let i = 1; i < ticks.length; i += 1) assert.ok(Math.abs(ticks[i] - ticks[i - 1] - step) < 1e-9);
}

test('niceTicks covers the range with nice steps and includes zero', () => {
  const cases = [
    [[-4.46, 2.43], { ticks: [-6, -4, -2, 0, 2, 4], step: 2, decimals: 0 }],
    [[-9.93, 4.29], { ticks: [-10, -5, 0, 5], step: 5, decimals: 0 }],
    [[-0.67, 2.45], { ticks: [-1, 0, 1, 2, 3], step: 1, decimals: 0 }],
    [[0, 0], { ticks: [-0.5, -0.25, 0, 0.25, 0.5], step: 0.25, decimals: 2 }],
    [[-9.5, 2.4], { ticks: [-10, -7.5, -5, -2.5, 0, 2.5], step: 2.5, decimals: 1 }],
  ];
  for (const [[min, max], expected] of cases) {
    const result = C.niceTicks(min, max);
    assert.deepEqual(result, expected, `${min}..${max}`);
    checkTicks(min, max, 6, result);
  }
  assert.deepEqual(C.niceTicks(-5.53, 4.16, 8).ticks, [-6, -4, -2, 0, 2, 4, 6]);
  assert.deepEqual(C.niceTicks(3, 3).ticks, [2.5, 2.75, 3, 3.25, 3.5]);
  assert.deepEqual(C.niceTicks(2.43, -4.46), C.niceTicks(-4.46, 2.43));
  assert.deepEqual(C.niceTicks(-3.6, 24.7, 2), { ticks: [-25, 0, 25], step: 25, decimals: 0 }, 'crossing zero needs 3 ticks');
  assert.deepEqual(C.niceTicks(0, 24.7, 2).ticks, [0, 25]);
  for (const [min, max, n] of [[-0.3, 0.9, 6], [-1.2, 0.6, 6], [0.1, 0.11, 5], [-1234, 5678, 7], [-0.04, 0.03, 6], [-3.2, 4.1, 4]]) {
    checkTicks(min, max, n, C.niceTicks(min, max, n));
  }
  assert.ok(!Object.is(C.niceTicks(-1.2, 0.6).ticks.find((x) => x === 0), -0), 'no negative zero');
  assert.throws(() => C.niceTicks(NaN, 1), TypeError);
});

function checkLayout(items, opts, map) {
  assert.ok(map instanceof Map);
  assert.equal(map.size, items.length);
  const sorted = items.map((it, i) => ({ ...it, i })).sort((a, b) => a.y - b.y || a.i - b.i);
  const ys = sorted.map((it) => map.get(it.key));
  const gap = Math.min(opts.minGap, (opts.bottom - opts.top) / Math.max(1, items.length - 1));
  for (let i = 0; i < ys.length; i += 1) {
    assert.ok(ys[i] >= opts.top - 1e-9 && ys[i] <= opts.bottom + 1e-9, `within bounds: ${ys[i]}`);
    if (i) assert.ok(ys[i] - ys[i - 1] >= gap - 1e-9, `no overlap between ${sorted[i - 1].key} and ${sorted[i].key}`);
  }
  return ys;
}

test('layoutLabels keeps order, spacing and bounds', () => {
  const opts = { minGap: 17, top: 0, bottom: 400 };
  const items = [{ key: 'a', y: 100 }, { key: 'b', y: 105 }, { key: 'c', y: 108 }, { key: 'd', y: 300 }, { key: 'e', y: 395 }, { key: 'f', y: 399 }];
  const map = C.layoutLabels(items, opts);
  checkLayout(items, opts, map);
  assert.equal(map.get('d'), 300, 'an isolated label stays where it is');
  assert.ok(Math.abs(map.get('b') - 104.333) < 0.01, 'a crowded group is centred on its targets');
  assert.equal(map.get('f'), 400, 'the bottom bound wins');
  assert.equal(map.get('e'), 383);
  const top = C.layoutLabels([{ key: 'x', y: -10 }, { key: 'y', y: 2 }], opts);
  assert.deepEqual([top.get('x'), top.get('y')], [0, 17]);
  const crowd = Array.from({ length: 10 }, (_, i) => ({ key: `k${i}`, y: 50 }));
  const squeezed = C.layoutLabels(crowd, { minGap: 17, top: 0, bottom: 100 });
  const ys = checkLayout(crowd, { minGap: 17, top: 0, bottom: 100 }, squeezed);
  assert.deepEqual(crowd.map((it) => squeezed.get(it.key)), ys, 'equal targets keep input order');
  assert.ok(Math.abs(ys[0]) < 1e-9 && Math.abs(ys[9] - 100) < 1e-9);
  const random = Array.from({ length: 30 }, (_, i) => ({ key: i, y: (i * 7919) % 230 }));
  const again = C.layoutLabels(random, { minGap: 17, top: 10, bottom: 600 });
  checkLayout(random, { minGap: 17, top: 10, bottom: 600 }, again);
  assert.deepEqual([...again], [...C.layoutLabels(random, { minGap: 17, top: 10, bottom: 600 })], 'deterministic');
  assert.equal(C.layoutLabels([], opts).size, 0);
  assert.equal(C.layoutLabels([{ key: 'z', y: 5 }], {}).get('z'), 5);
});

// ------------------------------------------------------------------ series math

test('segments keep 15-minute runs, dash a lunch gap and break a long gap', () => {
  const list = pts([['09:00', 1], ['09:15', 2], ['09:30', 3], ['10:15', 2], ['10:30', 1], ['10:44', 0], ['13:44', 5], ['13:59', 6]]);
  const seg = C.segments(list);
  assert.deepEqual(seg.map((s) => s.kind), ['line', 'gap', 'line', 'line']);
  assert.deepEqual(seg[0].points.map((p) => C.kstTime(p.t)), ['09:00', '09:15', '09:30']);
  assert.deepEqual(seg[1].points.map((p) => C.kstTime(p.t)), ['09:30', '10:15'], '45-minute gap is a dashed connector');
  assert.deepEqual(seg[2].points.map((p) => C.kstTime(p.t)), ['10:15', '10:30', '10:44'], 'a live tick 14 min later joins the line');
  assert.deepEqual(seg[3].points.map((p) => C.kstTime(p.t)), ['13:44', '13:59'], '3-hour gap has no connector');
  const edge = [{ t: at('09:00'), p: 0 }, { t: at('09:15') + 30000, p: 1 }, { t: at('09:30') + 60001, p: 2 }];
  assert.deepEqual(C.segments(edge).map((s) => s.kind), ['line', 'gap', 'line'], '15.5 min joins, anything longer is a gap');
  assert.equal(seg[1].points[0], list[2], 'segments reuse the point objects');
  assert.deepEqual(C.segments(pts([['09:00', 1], ['11:05', 2]])).map((s) => s.kind), ['line', 'gap', 'line'], '125 min still dashed');
  assert.deepEqual(C.segments(pts([['09:00', 1], ['11:06', 2]])).map((s) => s.kind), ['line', 'line']);
  assert.deepEqual(C.segments(pts([['09:00', 1], ['09:30', 2]]), 30).map((s) => s.kind), ['line']);
  assert.deepEqual(C.segments([]), []);
  assert.equal(C.segments(sv([['09:00', 1], ['09:15', 2]]).points)[0].points.length, 2, 'raw [iso, v, p] points work too');
});

test('valueAt takes the exact point or the latest one inside the tolerance', () => {
  const s = sv([['09:00', 1], ['09:15', 2], ['09:40', 3]]);
  assert.equal(C.valueAt(s, at('09:15')).p, 2);
  assert.equal(C.valueAt(s, at('09:20')).p, 2);
  assert.equal(C.valueAt(s, at('09:15') + 15 * MIN - 1).p, 2);
  assert.equal(C.valueAt(s, at('09:30')), null, 'the lower edge of the tolerance is excluded');
  assert.equal(C.valueAt(s, at('08:59')), null);
  assert.equal(C.valueAt(s, at('09:50')).p, 3);
  assert.equal(C.valueAt(s, at('10:30'), 60).p, 3);
  assert.equal(C.valueAt(s, at('09:15'), 0).p, 2, 'tolerance 0 still matches exactly');
  assert.equal(C.valueAt(s, at('09:16'), 0), null);
  assert.deepEqual(C.valueAt(s, iso('09:00')), { t: at('09:00'), v: 101, p: 1 });
  assert.equal(C.valueAt({ points: [] }, at('09:00')), null);
});

test('seriesView and stats work inside the display window', () => {
  const s = sv([['09:00', 0], ['09:15', -1], ['09:30', -2], ['09:45', -1.5], ['10:00', -2], ['10:15', -0.5], ['10:30', 4]]);
  const win = { start: at('09:00'), end: at('10:15') };
  assert.deepEqual(C.seriesView(s, win).map((p) => p.p), [0, -1, -2, -1.5, -2, -0.5]);
  assert.deepEqual(C.seriesView(s, { start: iso('09:30'), end: iso('09:45') }).map((p) => p.p), [-2, -1.5], 'ISO windows work');
  assert.equal(C.seriesView(s).length, 7);
  const st = C.stats(s, win);
  assert.equal(st.count, 6);
  assert.deepEqual([st.first.p, st.last.p, st.max.p], [0, -0.5, 0]);
  assert.deepEqual(st.min, { t: at('09:30'), v: 98, p: -2 }, 'the earliest of equal lows');
  assert.equal(st.recovery, 0.75);
  assert.equal(C.stats(s).recovery, 3, 'recovery beyond the baseline exceeds 1');
  assert.equal(C.stats(sv([['09:00', 0], ['09:15', -0.5], ['09:30', 0.2]])).recovery, null, 'shallow dips have no recovery');
  assert.equal(C.stats(s, { start: at('11:00'), end: at('12:00') }), null);
  assert.equal(C.stats({ points: [] }), null);
});

test('displayWindow clips notes.display to the session window', () => {
  const session = syntheticSession();
  const full = { start: at('08:00'), end: at('16:00') };
  assert.deepEqual(C.displayWindow(session, null), full);
  assert.deepEqual(C.displayWindow(session, { display: { start: '09:00', end: '15:00' } }), { start: at('09:00'), end: at('15:00') });
  assert.deepEqual(C.displayWindow(session, { display: { start: '07:00', end: '17:00' } }), full);
  assert.deepEqual(C.displayWindow(session, { display: { end: '15:00' } }), { start: at('08:00'), end: at('15:00') });
  assert.deepEqual(C.displayWindow(session, { display: { start: '9:00', end: 'late' } }), full);
  assert.deepEqual(C.displayWindow(session, { display: { start: '17:00', end: '18:00' } }), full);
});

test('eventsInWindow sorts events and keeps bands that overlap the window', () => {
  const notes = syntheticNotes();
  notes.events.push({ at: iso('07:30'), end: iso('08:10'), label: '이른 띠', kind: 'band' });
  notes.events.push({ at: iso('07:55'), label: '창 밖', kind: 'other' });
  notes.events.push({ at: iso('12:15'), label: '같은 시각', kind: 'other' });
  const win = { start: at('08:00'), end: at('16:00') };
  assert.deepEqual(C.eventsInWindow(notes, win).map((e) => e.label), ['이른 띠', '하원 투영', '같은 시각', 'TX', 'OH', '상원 확정']);
  assert.equal(C.eventsInWindow(notes, win)[5], notes.events[3], 'the original event objects are returned');
  assert.deepEqual(C.eventsInWindow(notes, { start: at('13:30'), end: at('16:00') }).map((e) => e.label), ['상원 확정']);
  assert.deepEqual(C.eventsInWindow(null, win), []);
  assert.deepEqual(C.eventsInWindow({ events: [{ at: 'soon', label: 'x' }] }, win), []);
});

// ------------------------------------------------------------------ table & insights

test('hourlyTable lists hourly values plus the low and the last value per series', () => {
  const session = syntheticSession();
  const table = C.hourlyTable(session, 'indices', C.displayWindow(session, null));
  assert.deepEqual(table.columns, [{ id: 'kospi', label: '코스피' }, { id: 'hsi', label: '항셍' }]);
  assert.deepEqual(table.rows.map((r) => r.label),
    ['08:00', '09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '최저', '마지막']);
  assert.deepEqual(table.rows.map((r) => r.kind), [...Array(9).fill('hour'), 'min', 'last']);
  for (const row of table.rows) {
    assert.equal(row.cells.length, 2);
    for (const cell of row.cells) if (cell) assert.deepEqual(Object.keys(cell).sort(), ['p', 't', 'v']);
  }
  assert.deepEqual(table.rows[0].cells, [null, null]);
  assert.equal(table.rows[1].cells[0].p, 1);
  assert.equal(table.rows[1].cells[1], null);
  assert.equal(table.rows[3].cells[1].p, -0.2);
  assert.equal(table.rows[8].cells[0], null, 'kospi ended at 15:30, outside the 16:00 tolerance');
  assert.equal(table.rows[8].cells[1].p, 1);
  assert.deepEqual(table.rows[9].cells.map((c) => [C.kstTime(c.t), c.p]), [['12:45', -3], ['11:00', -0.2]]);
  assert.deepEqual(table.rows[10].cells.map((c) => [C.kstTime(c.t), c.p]), [['15:30', 0.5], ['16:00', 1]]);
  assert.equal(table.rows[9].cells[0].v, 970);
  const narrow = C.hourlyTable(session, 'crypto', { start: at('09:00'), end: at('15:00') });
  assert.deepEqual(narrow.rows.map((r) => r.label), ['09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '최저', '마지막']);
  assert.deepEqual(narrow.rows[8].cells.map((c) => C.kstTime(c.t)), ['15:00', '15:00']);
  const none = C.hourlyTable(session, 'nope', { start: at('09:00'), end: at('10:00') });
  assert.deepEqual(none, { columns: [], rows: [
    { label: '09:00', kind: 'hour', t: at('09:00'), cells: [] }, { label: '10:00', kind: 'hour', t: at('10:00'), cells: [] },
    { label: '최저', kind: 'min', cells: [] }, { label: '마지막', kind: 'last', cells: [] }] });
});

test('insights find the common bottom, the joint rebound and the late mover', () => {
  const session = syntheticSession();
  const notes = syntheticNotes();
  C.validateSession(session);
  C.validateNotes(notes);
  const bullets = C.insights(session, notes, C.displayWindow(session, notes));
  assert.deepEqual(bullets.map((b) => b.kind), ['bottom', 'rebound', 'recovery', 'drawdown', 'resilient', 'late', 'last']);
  const text = Object.fromEntries(bullets.map((b) => [b.kind, b.text]));
  assert.equal(text.bottom, '바닥 시각: 3/4개 계열이 12:45에 최저점 (이 구간 사건: TX)');
  assert.ok(!text.bottom.includes('하원 투영') && !text.bottom.includes('상원 확정'), 'only events within ±15 min of the bottom');
  assert.equal(text.rebound, '가장 가파른 동반 반등: 13:00–13:30 (평균 +1.0p · 이 구간 사건: TX, OH, 상원 확정)');
  assert.equal(text.recovery, '낙폭 회복률 상위: 코스피 117% · BTC 105% / 하위: ETH 75% · SK하이닉스 80%');
  assert.equal(text.drawdown, '가장 깊은 낙폭: SK하이닉스 −5.0%(12:45) · 코스피 −3.0%(12:45) · BTC −2.0%(12:45)');
  assert.equal(text.resilient, '기준선 아래로 거의 내려가지 않은 계열: 항셍(최저 −0.2%) · 금 선물(최저 0.0%)');
  assert.equal(text.late, '금 선물: 14:30 이후 +1.5p (다른 자산 반등 이후 움직임)');
  assert.equal(text.last, '마지막 값 상위: 금 선물 +1.8% · 항셍 +1.0% · 코스피 +0.5% / 하위: SK하이닉스 −1.0% · 달러/원 −0.3% · ETH −0.3%');
  for (const b of bullets) assert.ok(!b.text.includes('\u2014') && !b.text.includes('-'), `no em dash or hyphen-minus: ${b.text}`);
  assert.deepEqual(C.insights(session, notes), bullets, 'the display window is the default');
  assert.deepEqual(C.insights(clone(session), clone(notes)), bullets, 'deterministic');
});

test('insights skip bullets whose inputs are insufficient', () => {
  const session = syntheticSession();
  assert.equal(C.insights(session, null).find((b) => b.kind === 'bottom').text, '바닥 시각: 3/4개 계열이 12:45에 최저점');
  const unlabeled = { events: [{ at: iso('12:50') }, { at: iso('12:52'), label: ' ' }, { at: iso('12:55'), label: 'TX' }] };
  assert.equal(C.insights(session, unlabeled)[0].text, '바닥 시각: 3/4개 계열이 12:45에 최저점 (이 구간 사건: TX)',
    'events without a usable label are not listed');
  session.series = session.series.filter((s) => ['kospi', 'hsi', 'usdkrw'].includes(s.id));
  const kinds = C.insights(session, null).map((b) => b.kind);
  assert.deepEqual(kinds, ['drawdown', 'resilient', 'last'], 'no bottom (1 dip), rebound (<5 series), recovery (<2) or late bullet');
  assert.deepEqual(C.insights({ ...session, series: [] }, null), []);
  const flat = syntheticSession();
  flat.series = flat.series.filter((s) => s.id === 'usdkrw');
  assert.deepEqual(C.insights(flat, null).map((b) => b.kind), ['drawdown']);
});

// ------------------------------------------------------------------ validation

test('validateSession accepts a well-formed session and tolerates unknown fields', () => {
  const session = syntheticSession();
  assert.equal(C.validateSession(session), session);
  const extended = syntheticSession();
  extended.futureField = { any: 1 };
  extended.series[0].futureField = true;
  extended.series[0].points[0].push('extra');
  extended.series.push({ id: 'nikkei', panel: 'indices', label: '니케이225', basis: 'prevClose',
    baseline: { value: null, label: '' }, source: { provider: 'yahoo', symbol: '^N225' },
    status: 'missing', note: '자료 없음(휴장 또는 개장 전)', fetchedAt: null, points: [] });
  extended.series.push({ id: 'nq', panel: 'indices', label: '나스닥100 선물', basis: 'windowStart',
    baseline: { value: 28409.75, label: '08:00 KST 시가' }, source: { provider: 'yahoo', symbol: 'NQ=F' },
    status: 'stale', note: 'Yahoo 요청 제한(HTTP 429)', points: [[iso('08:00'), 28409.75, 0]] });
  assert.doesNotThrow(() => C.validateSession(extended));
});

test('validateSession rejects contract violations with a path', () => {
  const cases = [
    ['unsorted points', (s) => { const p = s.series[0].points; [p[1], p[2]] = [p[2], p[1]]; },
      /^session\.series\[0\]\.points\[2\]: times must be strictly ascending/],
    ['duplicate time', (s) => { s.series[0].points[1][0] = s.series[0].points[0][0]; }, /strictly ascending/],
    ['point after the window', (s) => { const p = s.series[3].points; p[p.length - 1][0] = '2026-11-04T07:15:00Z'; },
      /^session\.series\[3\]\.points\[32\]: time .* is outside the session window/],
    ['point before the window', (s) => { s.series[3].points[0][0] = '2026-11-03T22:45:00Z'; }, /outside the session window/],
    ['pct inconsistent', (s) => { s.series[0].points[4][2] += 0.02; }, /^session\.series\[0\]\.points\[4\]\[2\]: pct .* does not match/],
    ['unknown panel', (s) => { s.series[1].panel = 'bonds'; }, /^session\.series\[1\]\.panel: unknown panel "bonds"/],
    ['duplicate ids', (s) => { s.series[2].id = 'kospi'; }, /^session\.series\[2\]\.id: duplicate series id 'kospi'/],
    ['bad status', (s) => { s.series[0].status = 'fresh'; }, /^session\.series\[0\]\.status: expected one of/],
    ['http provider url', (s) => { s.providers[0].url = 'http://finance.yahoo.com/'; }, /^session\.providers\[0\]\.url: expected an https:\/\/ URL/],
    ['javascript license url', (s) => { s.providers[1].licenseUrl = 'javascript:alert(1)'; }, /licenseUrl: expected an https/],
    ['null baseline while ok', (s) => { s.series[0].baseline.value = null; }, /null is allowed only when status is missing or error/],
    ['points while missing', (s) => { s.series[0].status = 'missing'; }, /must be empty when status is 'missing'/],
    ['zero value', (s) => { s.series[0].points[0][1] = 0; }, /value must be a positive finite number/],
    ['string pct', (s) => { s.series[0].points[0][2] = '1.0'; }, /pct must be a finite number/],
    ['short point', (s) => { s.series[0].points[0] = [s.series[0].points[0][0], 1010]; }, /expected \[time, value, pct\]/],
    ['time without Z', (s) => { s.series[0].points[0][0] = '2026-11-04T00:00:00+09:00'; }, /expected an ISO UTC time ending in Z/],
    ['impossible time', (s) => { s.generatedAt = '2026-11-04T24:00:00Z'; }, /^session\.generatedAt: expected an ISO UTC time/],
    ['window reversed', (s) => { s.window = { start: s.window.end, end: s.window.start }; }, /^session\.window: start must be before end/],
    ['window too long', (s) => { s.window.end = '2026-11-05T00:00:00Z'; }, /span must be 24 hours or less/],
    ['window on another date', (s) => { s.date = '2026-11-05'; }, /must fall on the session date/],
    ['wrong kind', (s) => { s.kind = 'notes'; }, /^session\.kind: expected 'session'/],
    ['old schema', (s) => { s.schemaVersion = 2; }, /^session\.schemaVersion: expected 3/],
    ['bad date', (s) => { s.date = '2026-11-31'; }, /^session\.date: expected a YYYY-MM-DD date/],
    ['other timezone', (s) => { s.timezone = 'UTC'; }, /timezone/],
    ['final missing', (s) => { delete s.final; }, /^session\.final: expected true or false/],
    ['bad basis', (s) => { s.series[0].basis = 'open'; }, /basis: expected one of prevClose\|windowStart/],
    ['empty label', (s) => { s.series[0].label = ' '; }, /label: must not be empty/],
    ['bad interval', (s) => { s.intervalMinutes = 0; }, /intervalMinutes: expected a positive integer/],
    ['long note', (s) => { s.series[0].note = 'x'.repeat(4001); }, /note: longer than 4000 characters/],
  ];
  for (const [name, mutate, pattern] of cases) {
    const s = syntheticSession();
    mutate(s);
    throwsMessage(() => C.validateSession(s), pattern, name);
  }
  throwsMessage(() => C.validateSession(null), /^session: expected an object/);
  throwsMessage(() => C.validateSession([]), /^session: expected an object/);
});

test('validateIndex checks entries and their newest-first order', () => {
  const index = { schemaVersion: 3, kind: 'index', updatedAt: '2026-11-04T11:40:12Z', sessions: [
    { date: '2026-11-04', title: '미국 중간선거 개표 × 아시아 증시 × 크립토', final: true, seriesWithData: 19, updatedAt: '2026-11-04T11:40:12Z', hasNotes: true },
    { date: '2026-11-03', title: null, final: true, seriesWithData: 0, updatedAt: '2026-11-03T07:30:00Z', hasNotes: false, extra: 'ok' },
  ] };
  assert.equal(C.validateIndex(index), index);
  assert.doesNotThrow(() => C.validateIndex({ ...index, sessions: [] }));
  const cases = [
    [(x) => { x.sessions.reverse(); }, /^index\.sessions\[1\]\.date: sessions must be sorted by date, newest first/],
    [(x) => { x.sessions[1].date = x.sessions[0].date; }, /without duplicates/],
    [(x) => { x.sessions[0].date = '11/4'; }, /^index\.sessions\[0\]\.date: expected a YYYY-MM-DD date/],
    [(x) => { x.updatedAt = 'yesterday'; }, /^index\.updatedAt/],
    [(x) => { x.kind = 'session'; }, /^index\.kind/],
    [(x) => { delete x.sessions[0].final; }, /^index\.sessions\[0\]\.final/],
    [(x) => { x.sessions[0].seriesWithData = -1; }, /seriesWithData/],
    [(x) => { x.sessions[0].title = 5; }, /^index\.sessions\[0\]\.title: expected a string/],
    [(x) => { x.sessions = {}; }, /^index\.sessions: expected an array/],
  ];
  for (const [mutate, pattern] of cases) {
    const x = clone(index);
    mutate(x);
    throwsMessage(() => C.validateIndex(x), pattern, String(pattern));
  }
});

function fullNotes() {
  return {
    schemaVersion: 3, kind: 'notes', date: DATE,
    title: '미국 중간선거 개표 × 아시아 증시 × 크립토',
    subtitle: '세로 점선 = 선거 호출 시각 · 파란 띠 = 상원 확정~트럼프 승복(13:22~13:37)',
    asOf: '2026-11-04T06:00:00Z', author: 'Claude', display: { start: '08:00', end: '16:00' },
    headline: '개표가 민주당 쪽으로 기울수록 **아시아 AI·반도체**가 팔렸다.',
    events: [
      { id: 'ga', at: '2026-11-04T00:39:00Z', label: '오소프(GA)', sub: '수성', kind: 'call', source: '방송사 투영',
        url: 'https://www.cbsnews.com/live-updates/election-day-2026-midterms/', detail: '짧은 설명',
        alts: [{ source: 'DDHQ', at: '2026-11-04T00:18:00Z', url: 'https://votes.decisiondeskhq.com/' }, { source: 'AP' }] },
      { id: 'senate', at: '2026-11-04T04:22:00Z', end: '2026-11-04T04:37:00Z', label: '상원 확정', sub: '트럼프 승복',
        kind: 'band', source: 'NYT·NBC·AP' },
      { at: '2026-11-04T05:45:00Z', label: '콜린스', sub: '승복' },
    ],
    observations: ['분석가가 쓴 항목'],
    sections: [{ id: 'asia', heading: '아시아 증시 세부', items: ['항목'] }, { heading: '읽기', items: [] }],
    watch: ['15:30 코스피·니케이 마감'],
    story: [
      { text: '아침 8시, ...', sources: [{ label: '파이낸셜뉴스', url: 'https://www.fnnews.com/news/202611040758072019' }, { label: 'Yahoo Finance 15분봉' }] },
      { text: '출처 없는 단락' },
    ],
    verdict: '판정 문장', footnote: '미확인: 마감 수치', somethingNew: [1, 2, 3],
  };
}

test('validateNotes accepts analyst notes, including label-only story sources', () => {
  const notes = fullNotes();
  assert.equal(C.validateNotes(notes), notes);
  assert.doesNotThrow(() => C.validateNotes({ schemaVersion: 3, kind: 'notes', date: DATE }));
  assert.doesNotThrow(() => C.validateNotes({ schemaVersion: 3, kind: 'notes', date: DATE, title: null, events: null }));
});

test('validateNotes rejects unsafe or malformed notes', () => {
  const cases = [
    [(n) => { n.story[0].sources[0].url = 'http://www.fnnews.com/'; }, /^notes\.story\[0\]\.sources\[0\]\.url: expected an https:\/\/ URL/],
    [(n) => { n.events[0].url = 'javascript:alert(1)'; }, /^notes\.events\[0\]\.url: expected an https/],
    [(n) => { n.events[0].alts[0].url = 'ftp://x'; }, /^notes\.events\[0\]\.alts\[0\]\.url/],
    [(n) => { delete n.events[1].end; }, /^notes\.events\[1\]\.end: a band needs an end time/],
    [(n) => { n.events[1].end = n.events[1].at; }, /^notes\.events\[1\]\.end: must be after at/],
    [(n) => { n.events[0].at = '2026-11-04 09:39'; }, /^notes\.events\[0\]\.at: expected an ISO UTC time/],
    [(n) => { n.events[0].kind = 'rumor'; }, /^notes\.events\[0\]\.kind: expected one of/],
    [(n) => { delete n.events[2].label; }, /^notes\.events\[2\]\.label: expected a string/],
    [(n) => { n.events[2].id = 'ga'; }, /duplicate event id 'ga'/],
    [(n) => { n.headline = 'x'.repeat(4001); }, /^notes\.headline: longer than 4000 characters/],
    [(n) => { n.observations = ['ok', 3]; }, /^notes\.observations\[1\]: expected a string/],
    [(n) => { n.sections[0].items = 'one'; }, /^notes\.sections\[0\]\.items: expected an array/],
    [(n) => { delete n.sections[1].heading; }, /^notes\.sections\[1\]\.heading/],
    [(n) => { n.story[1].text = ''; }, /^notes\.story\[1\]\.text: must not be empty/],
    [(n) => { n.story[0].sources[1] = { url: 'https://example.com/' }; }, /^notes\.story\[0\]\.sources\[1\]\.label/],
    [(n) => { n.display = { start: '8:00' }; }, /^notes\.display\.start: expected HH:MM/],
    [(n) => { n.display = { start: '16:00', end: '08:00' }; }, /^notes\.display: start must be before end/],
    [(n) => { n.asOf = 'today'; }, /^notes\.asOf/],
    [(n) => { n.kind = 'session'; }, /^notes\.kind/],
    [(n) => { n.date = '2026-13-01'; }, /^notes\.date/],
  ];
  for (const [mutate, pattern] of cases) {
    const n = fullNotes();
    mutate(n);
    throwsMessage(() => C.validateNotes(n), pattern, String(pattern));
  }
});

test('renderInline escapes HTML before turning **bold** into <strong>', () => {
  assert.equal(C.renderInline('<b>**굵게**</b> & "따옴표" \'홑\''),
    '&lt;b&gt;<strong>굵게</strong>&lt;/b&gt; &amp; &quot;따옴표&quot; &#39;홑&#39;');
  assert.equal(C.renderInline('**<img src=x onerror=alert(1)>**'), '<strong>&lt;img src=x onerror=alert(1)&gt;</strong>');
  assert.equal(C.renderInline('**a** 그리고 **b**'), '<strong>a</strong> 그리고 <strong>b</strong>');
  assert.equal(C.renderInline('닫히지 않은 **별표'), '닫히지 않은 **별표');
  assert.equal(C.renderInline(null), '');
  assert.equal(C.escapeHtml(undefined), '');
  assert.equal(C.escapeHtml(5), '5');
  assert.equal(C.escapeHtml('<a href="x">\'</a>'), '&lt;a href=&quot;x&quot;&gt;&#39;&lt;/a&gt;');
});

// ------------------------------------------------------------------ real 11/4 data (local only)

function baselineLabel(raw) {
  const close = /^\d{4}-(\d{2})-(\d{2}) 종가$/.exec(raw);
  if (close) return `${Number(close[1])}/${Number(close[2])} 종가`;
  return raw === '08:00 open' ? '08:00 KST 시가' : '08:00 KST';
}

function sessionFromTruth(truth) {
  return {
    schemaVersion: 3, kind: 'session', date: DATE, timezone: 'Asia/Seoul', window: C.sessionWindow(DATE),
    intervalMinutes: 15, generatedAt: '2026-11-04T11:40:12Z', final: true,
    series: C.SERIES.map((d) => {
      const t = truth[d.id];
      return {
        id: d.id, panel: d.panel, label: d.label, basis: d.basis,
        baseline: { value: t.base, label: baselineLabel(t.blabel) },
        source: clone(d.sources[0]), status: 'ok', note: '', fetchedAt: '2026-11-04T11:36:00Z',
        points: t.pts.map(([sec, value]) => [C.isoUtc(sec * 1000), value, C.pctChange(value, t.base)]),
      };
    }),
    providers: clone(C.PROVIDERS),
  };
}

test('a session built from the real 11/4 values validates and matches the known low', {
  skip: !fs.existsSync(TRUTH_FILE) && 'truth file for 2026-11-04 is not available',
}, () => {
  const truth = JSON.parse(fs.readFileSync(TRUTH_FILE, 'utf8'));
  const session = clone(sessionFromTruth(truth));
  assert.equal(C.validateSession(session), session);
  for (const s of session.series) {
    const t = truth[s.id];
    assert.equal(s.points.length, t.pts.length, s.id);
    s.points.forEach((pt, i) => assert.ok(Math.abs(pt[2] - t.pts[i][2]) <= 0.0051, `${s.id} pct ${pt[2]} vs ${t.pts[i][2]}`));
  }
  const kospi = session.series.find((s) => s.id === 'kospi');
  const st = C.stats(kospi, C.displayWindow(session, null));
  assert.equal(Math.round(st.min.p * 100) / 100, -3.93);
  assert.equal(C.kstTime(st.min.t), '12:45');
  assert.equal(C.formatPct(st.min.p), '−3.9%');
  assert.equal(C.kstTime(st.last.t), '15:30');
  assert.equal(Math.round(st.recovery * 100), 116);
  const bullets = C.insights(session, null);
  assert.equal(bullets[0].text, '바닥 시각: 11/17개 계열이 12:15–12:45에 최저점');
  assert.match(bullets.find((b) => b.kind === 'drawdown').text, /^가장 깊은 낙폭: 소프트뱅크 −9\.9%\(12:45\)/);
  assert.match(bullets.find((b) => b.kind === 'resilient').text, /항셍\(최저 −0\.5%\)/);
  for (const panel of C.PANELS) {
    const table = C.hourlyTable(session, panel.key, C.displayWindow(session, null));
    assert.equal(table.rows.length, 11, panel.key);
  }
});
