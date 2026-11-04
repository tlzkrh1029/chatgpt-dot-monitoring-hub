'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../parallel-data.js');
const NOW = Date.parse('2026-11-04T09:00:00Z');
const prices = 'panel,series,time_kst,pct\n주식지수,표본 지수,08:00,0\n주식지수,표본 지수,08:15,0.25\n주식지수,표본 지수,08:30,\n주식지수,표본 지수,11:15,-0.35\n주식지수,표본 지수,14:00,0.45\n주식지수,표본 지수,14:15,0.5\n주식지수,표본 지수,14:53,0.6\n';
const events = 'time_kst,event,type\n09:39,표본 선거 판단,방송사 투영\n13:22,표본 발언,인터뷰\n14:37,표본 후보 승복,후보 승복\n';
const local = () => P.parseReference(prices, events);
const empty = () => { const data = local(); data.series[0].points = []; data.series[0].asOf = null; data.events = []; return data; };
function observed() {
  const data = local(); data.mode = 'observed'; data.publishedAt = '2026-11-04T06:20:00Z'; data.events = [];
  Object.assign(data.series[0], { verification: 'verified', redistribution: 'permitted', sourceUrl: 'https://www.tradingview.com/widget-docs/',
    observedAt: '2026-11-04T06:10:00Z', availability: 'delayed', delaySeconds: 180 });
  return data;
}
test('reference CSV preserves exact irregular timestamps and values, groups panels and never asserts verification', () => {
  const data = local();
  assert.deepEqual(P.PANELS.map(panel => panel.key), ['indices', 'ai', 'crypto', 'fx']);
  assert.equal(data.series[0].points.length, 6);
  assert.equal(data.series[0].points.at(-1).at, '2026-11-04T05:53:00.000Z');
  assert.equal(data.series[0].points.at(-1).pct, 0.6);
  assert.equal(data.series[0].asOf, data.series[0].points.at(-1).at);
  assert.ok(data.series.every(series => series.verification === 'unverified' && series.redistribution === 'unverified'));
  assert.deepEqual(data.events.map(event => event.type), ['media_call', 'statement', 'concession']);
  assert.ok(data.events.every(event => event.verification === 'unverified' && event.sourceUrl === null));
  assert.equal(data.publishedAt, null);
});
test('long gaps and absent grid cells split paths without inventing zeroes or shifting off-grid endpoints', () => {
  const data = local(), series = data.series[0];
  assert.deepEqual(P.segments(series.points).map(segment => segment.length), [2, 1, 2, 1]);
  assert.equal(P.segments(series.points).at(-1)[0].at, series.asOf);
  const summary = P.summarizeSeries(series, data.window);
  assert.equal(summary.expectedGridCount, 28);
  assert.equal(summary.missingGridCount, 23);
  assert.equal(summary.offGridCount, 1);
  assert.deepEqual(summary.gaps[1], { start: '2026-11-04T02:15:00.000Z', end: '2026-11-04T05:00:00.000Z' });
  assert.deepEqual(P.summarizeSeries(empty().series[0], data.window), { firstAt: null, lastAt: null, pointCount: 0, expectedGridCount: 0, missingGridCount: 0, offGridCount: 0, gaps: [] });
});
test('grid statistics only count between first and last observations, without counting closed session edges as missing', () => {
  const data = local();
  const series = { points: [{ at: '2026-11-04T00:00:00Z', pct: 1 }, { at: '2026-11-04T00:15:00Z', pct: 2 }] };
  const summary = P.summarizeSeries(series, data.window);
  assert.equal(summary.expectedGridCount, 2); assert.equal(summary.missingGridCount, 0);
});
test('public validation rejects reference numeric values/events; empty unsupported configuration is allowed', () => {
  assert.throws(() => P.validateDataset(local(), { now: NOW }), /local only/);
  assert.doesNotThrow(() => P.validateDataset(empty(), { now: NOW }));
  const data = empty(); data.events = local().events;
  assert.throws(() => P.validateDataset(data, { now: NOW }), /reference events are local only/);
});
test('observed values need evidence, permission and real source clocks; validation clones the payload', () => {
  const data = observed(), result = P.validateDataset(data, { now: NOW });
  result.series[0].points[0].pct = 99;
  assert.equal(data.series[0].points[0].pct, 0);
  for (const [field, value] of [['verification', 'unverified'], ['redistribution', 'unverified'], ['sourceUrl', null], ['observedAt', null]]) {
    const bad = observed(); bad.series[0][field] = value;
    assert.throws(() => P.validateDataset(bad, { now: NOW }), /require/);
  }
  const bad = observed(); bad.publishedAt = null;
  assert.throws(() => P.validateDataset(bad, { now: NOW }), /require/);
});
test('source, observation and publication clocks cannot be substituted or regress within a payload', () => {
  const data = observed(); data.series[0].observedAt = '2026-11-04T05:30:00Z';
  assert.throws(() => P.validateDataset(data, { now: NOW }), /newer than the observation/);
  const later = observed(); later.series[0].observedAt = '2026-11-04T06:30:00Z';
  assert.throws(() => P.validateDataset(later, { now: NOW }), /newer than publication/);
  const wrong = observed(); wrong.series[0].asOf = '2026-11-04T05:54:00Z';
  assert.throws(() => P.validateDataset(wrong, { now: NOW }), /final source point/);
});
test('verified event lines require an independently checked source and distinguish media calls from certification', () => {
  const data = observed();
  data.events = [{ id: 'verified-call', at: '2026-11-04T01:30:00Z', label: '표본 당선 판단', type: 'media_call',
    verification: 'verified', sourceUrl: 'https://votes.decisiondeskhq.com/races/', observedAt: '2026-11-04T06:00:00Z' }];
  assert.equal(P.validateDataset(data, { now: NOW }).events[0].type, 'media_call');
  data.events[0].sourceUrl = null;
  assert.throws(() => P.validateDataset(data, { now: NOW }), /verified events require/);
  data.events[0].sourceUrl = 'https://votes.decisiondeskhq.com/races/';
  data.events[0].observedAt = '2026-11-04T01:00:00Z';
  assert.throws(() => P.validateDataset(data, { now: NOW }), /chronology/);
});
test('unsafe URLs, unknown fields, credentials, duplicate points and invalid timestamps fail closed', () => {
  for (const url of ['https://foo.com/?token=secret', 'https://user:pass@foo.com/', 'http://foo.com/', 'https://docs.google.com/document/123']) {
    const data = observed(); data.series[0].sourceUrl = url;
    assert.throws(() => P.validateDataset(data, { now: NOW }));
  }
  for (const mutate of [data => { data.secret = 'hidden'; }, data => { data.series[0].extra = 1; },
    data => { data.series[0].points[1].at = data.series[0].points[0].at; },
    data => { data.series[0].points[1].pct = NaN; }, data => { data.series[0].points[1].at = '2026-02-30T00:15:00Z'; },
    data => { data.series[0].provider = 'api_key=private'; }, data => { data.series[0].delaySeconds = -1; }]) {
    const data = observed(); mutate(data); assert.throws(() => P.validateDataset(data, { now: NOW }));
  }
});
test('CSV supports BOM, CRLF and escaped quoted cells but rejects unknown panels, duplicate and malformed values', () => {
  const parsed = P.parseReference('\uFEFFpanel,series,time_kst,pct\r\n크립토,"표본, 코인",08:00,0.125\r\n\r\n', 'time_kst,event,type\r\n');
  assert.equal(parsed.series[0].label, '표본, 코인'); assert.equal(parsed.series[0].points[0].pct, 0.125);
  for (const csv of [prices + '주식지수,표본 지수,08:00,1\n', prices.replace('0.25', 'NaN'), prices.replace('08:15', '08:99'),
    prices.replace('주식지수', '알 수 없는 패널'), prices.replace('panel,series,time_kst,pct', 'panel,series,time_kst,value'),
    'panel,series,time_kst,pct\n주식지수,"미완성,08:00,1']) assert.throws(() => P.parseReference(csv, events));
});
