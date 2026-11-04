'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../parallel-data.js');
const { createController } = require('../parallel-refresh.js');
const fixture = require('./parallel-v2-fixture.js');
const NOW = Date.parse('2026-11-04T00:36:00Z');
const copy = value => JSON.parse(JSON.stringify(value));

test('v2 preserves raw prices, exact baseline and sampling independently from newest one-minute time', () => {
  const value = fixture();
  const validated = P.validateDataset(value, { now: NOW });
  assert.deepEqual(validated, value);
  assert.notEqual(value.series[0].asOf, value.providers[0].series[0].latest.at);
  assert.equal(P.sourceReceipt(value, value.series[0].id).receipt.baseline.value, '100.00');
  assert.equal(P.sourceReceipt(value, 'unsupported'), null);
  validated.providers[0].series[0].samples[0].value = '1';
  assert.equal(value.providers[0].series[0].samples[0].value, '100.00');
});

test('v2 rejects missing provenance, invalid clocks, nonpositive raw values, unsafe URLs and dishonest derived points', () => {
  for (const mutate of [
    value => { delete value.providers; },
    value => { value.mode = 'reference'; },
    value => { value.providers = []; },
    value => { value.providers[0].requestUrl += '&token=private'; },
    value => { value.providers[0].metric = 'PriceUSD'; },
    value => { value.providers[0].pages = 0; },
    value => { value.providers[0].series[0].id = 'other'; },
    value => { value.providers[0].series[0].asset = ''; },
    value => { value.providers[0].series[0].observedAt = '2026-11-04T00:34:31Z'; },
    value => { value.providers[0].observedAt = '2026-11-04T00:36:01Z'; },
    value => { value.providers[0].series[0].baseline.value = '0'; },
    value => { value.providers[0].series[0].baseline.value = 'Infinity'; },
    value => { value.providers[0].series[0].baseline.at = '2026-11-03T23:15:00Z'; },
    value => { value.providers[0].series[0].latest.at = '2026-11-04T00:29:00Z'; },
    value => { value.providers[0].series[0].latest.at = '2026-11-04T00:34:01Z'; },
    value => { value.providers[0].series[0].samples[1].at = value.series[0].points[1].at = value.series[0].asOf = '2026-11-04T00:30:00.000000001Z'; },
    value => { value.series[0].asOf = '2026-11-04T00:30:00.000000001Z'; },
    value => { value.series[0].delaySeconds = 0; },
    value => { value.providers[0].series[0].samples.pop(); },
    value => { value.providers[0].series[0].samples[1].value = '101'; },
    value => { value.providers[0].series[0].samples[0].at = '2026-11-03T23:15:00Z'; },
    value => { value.series[0].sourceUrl = 'https://www.kraken.com/'; },
    value => { value.providers[0].requestedEndAt = '2026-11-04T00:30:00Z'; }
  ]) {
    const value = fixture(); mutate(value);
    assert.throws(() => P.validateDataset(value, { now: NOW }));
  }
});

test('source age is derived from newest one-minute calculation and advances without new JSON receipts', () => {
  const value = fixture(), id = value.series[0].id;
  const first = P.sourceFreshness(value, id, '2026-11-04T00:35:00Z');
  assert.equal(first.ageSeconds, 60);
  assert.equal(first.stale, false);
  assert.equal(P.sourceFreshness(value, id, '2026-11-04T00:53:59Z').stale, false);
  assert.equal(P.sourceFreshness(value, id, '2026-11-04T00:54:00Z').stale, true);
  assert.equal(P.sourceFreshness(value, 'unconnected', NOW), null);
});

test('raw decimal equality preserves sub-double precision while accepting equivalent zero padding', () => {
  assert.equal(P.sameRate('00103.000', '103'), true);
  assert.equal(P.sameRate('103.000000000000001', '103.000000000000002'), false);
  const baselineConflict = fixture();
  baselineConflict.providers[0].series[0].baseline.value = '100.000000000000001';
  baselineConflict.providers[0].series[0].samples[0].value = '100.000000000000002';
  assert.throws(() => P.validateDataset(baselineConflict, { now: NOW }), /baseline observation/);
  const latestConflict = fixture();
  latestConflict.providers[0].series[0].latest = { ...latestConflict.providers[0].series[0].samples[1], value: '102.000000000000001' };
  latestConflict.series[0].delaySeconds = 270;
  assert.throws(() => P.validateDataset(latestConflict, { now: NOW }), /latest raw value conflicts/);
});

async function transition(original, candidate, now = NOW) {
  let payload = original;
  const controller = createController({ now: () => now, fetchImpl: async () => ({ ok: true, json: async () => copy(payload) }) });
  const first = await controller.refresh();
  assert.equal(first.error, '');
  payload = candidate;
  return { first, next: await controller.refresh() };
}

test('v1 empty manifest can gain v2 daily source IDs while preserving provider evidence on later refreshes', async () => {
  const current = fixture();
  const empty = copy(current); empty.schemaVersion = 1; delete empty.providers;
  empty.series = []; empty.publishedAt = '2026-11-04T00:20:00Z';
  const migrated = await transition(empty, current);
  assert.equal(migrated.next.error, '');
  for (const mutate of [
    value => { value.schemaVersion = 1; delete value.providers; },
    value => { value.providers[0].licenseName = 'Different license'; },
    value => { value.providers[0].transformation = 'Different calculation'; },
    value => { value.providers[0].series[0].baseline.value = '200'; value.providers[0].series[0].samples.forEach(sample => { sample.value = String(Number(sample.value) * 2); }); },
    value => { value.providers[0].series[0].latest.at = '2026-11-04T00:33:00Z'; value.series[0].delaySeconds = 90; },
    value => { value.providers[0].series[0].latest.value = '104'; }
  ]) {
    const candidate = fixture(); mutate(candidate);
    const { first, next } = await transition(current, candidate);
    assert.ok(next.error);
    assert.deepEqual(next.data, first.data);
  }
});

test('next daily baseline uses new IDs after all old observations leave the displayed window', async () => {
  const current = fixture();
  const shift = value => typeof value === 'string' && /^2026-\d\d-\d\dT/.test(value) ? new Date(Date.parse(value) + 86400000).toISOString() : Array.isArray(value) ? value.map(shift) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, shift(item)])) : value;
  const nextDay = shift(current);
  nextDay.series[0].id = 'synthetic-btc-2026-11-05';
  nextDay.series[0].basis = '2026-11-05 08:00 KST synthetic baseline';
  nextDay.providers[0].series[0].id = nextDay.series[0].id;
  const result = await transition(current, nextDay, NOW + 86400000);
  assert.equal(result.next.error, '');
  assert.deepEqual(result.next.data, nextDay);
});

test('refresh rejects tiny raw-rate rewrites even when their JavaScript Number and plotted percentage are equal', async () => {
  for (const field of ['baseline', 'latest', 'sample']) {
    const current = fixture();
    const raw = current.providers[0].series[0];
    if (field === 'baseline') raw.baseline.value = raw.samples[0].value = '100.000000000000001';
    else if (field === 'latest') raw.latest.value = '103.000000000000001';
    else raw.samples[1].value = '102.000000000000001';
    const candidate = copy(current), next = candidate.providers[0].series[0];
    if (field === 'baseline') next.baseline.value = next.samples[0].value = '100.000000000000002';
    else if (field === 'latest') next.latest.value = '103.000000000000002';
    else next.samples[1].value = '102.000000000000002';
    P.validateDataset(candidate, { now: NOW });
    const result = await transition(current, candidate);
    assert.ok(result.next.error, `${field} raw rewrite must fail`);
    assert.deepEqual(result.next.data, result.first.data);
  }
  const current = fixture(), equivalent = fixture();
  equivalent.providers[0].series[0].baseline.value = '00100.000';
  equivalent.providers[0].series[0].samples[0].value = '100';
  equivalent.providers[0].series[0].samples[1].value = '0102.0';
  equivalent.providers[0].series[0].latest.value = '0103.000';
  assert.equal((await transition(current, equivalent)).next.error, '');
});
