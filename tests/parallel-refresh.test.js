'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createController } = require('../parallel-refresh.js');

const NOW = Date.parse('2026-11-04T07:00:00Z');
const copy = value => JSON.parse(JSON.stringify(value));
// These are synthetic controller fixtures, not observations or a market feed.
function fixture() {
  return {
    schemaVersion: 1, mode: 'observed', title: 'Synthetic controller fixture',
    publishedAt: '2026-11-04T06:00:00Z',
    window: { start: '2026-11-03T23:00:00Z', end: '2026-11-04T06:00:00Z', timezone: 'Asia/Seoul', intervalMinutes: 15 },
    series: [{ id: 'synthetic', panel: 'crypto', label: 'Synthetic', instrument: 'TEST', basis: 'Synthetic baseline',
      provider: 'Synthetic test adapter', sourceUrl: 'https://www.okx.com/api/v5/market/candles?instId=BTC-USDT&bar=15m',
      verification: 'verified', redistribution: 'permitted', availability: 'available',
      asOf: '2026-11-04T04:00:00Z', observedAt: '2026-11-04T05:00:00Z', delaySeconds: 3600, marketState: 'unknown',
      points: [{ at: '2026-11-04T04:00:00Z', pct: 1 }] }],
    events: [{ id: 'synthetic-event', at: '2026-11-04T04:00:00Z', label: 'Synthetic event', type: 'media_call',
      verification: 'verified', sourceUrl: 'https://votes.decisiondeskhq.com/', observedAt: '2026-11-04T05:00:00Z' }],
    stories: []
  };
}
const response = value => ({ ok: true, json: async () => copy(value) });

test('parallel polling reads only its own file, omits credentials, and distinguishes receipt from source clocks', async () => {
  let clock = NOW;
  const requests = [];
  const changes = [];
  const original = fixture();
  const controller = createController({ now: () => clock,
    fetchImpl: async (url, options) => { requests.push({ url, options }); return response(original); },
    onChange: value => changes.push(value) });
  assert.equal(controller.snapshot().data, null);
  const first = await controller.refresh();
  clock += 600000;
  const second = await controller.refresh();
  assert.equal(first.error, '');
  assert.equal(second.error, '');
  assert.deepEqual(second.data, original);
  assert.equal(first.revision, 1);
  assert.equal(second.revision, 1);
  assert.notEqual(second.lastReceivedAt, first.lastReceivedAt);
  assert.equal(second.data.series[0].asOf, original.series[0].asOf);
  assert.equal(second.data.series[0].observedAt, original.series[0].observedAt);
  assert.equal(second.data.publishedAt, original.publishedAt);
  assert.equal(requests.length, 2);
  assert.notEqual(requests[0].url, requests[1].url);
  assert.ok(requests.every(item => /^data\/parallel\.json\?v=/.test(item.url)));
  assert.ok(requests.every(item => item.options.credentials === 'omit' && item.options.cache === 'no-store'));
  assert.ok(requests.every(item => item.options.headers.Accept === 'application/json'));
  assert.equal(changes.length, 2);
  second.data.title = 'Mutated client snapshot';
  changes[0].data.title = 'Mutated callback snapshot';
  assert.equal(controller.snapshot().data.title, original.title);
});

test('HTTP, parsing, schema and size failures retain last-good data and generic errors; recovery clears the error', async () => {
  const original = fixture();
  let current = async () => response(original);
  let clock = NOW;
  const controller = createController({ now: () => clock, fetchImpl: (...args) => current(...args) });
  const first = await controller.refresh();
  assert.equal(first.error, '');
  for (const failed of [
    async () => { throw new Error('private payload'); },
    async () => ({ ok: false }),
    async () => ({ ok: true, text: async () => '{private malformed payload' }),
    async () => response({ ...original, unknownField: 'private payload' }),
    async () => ({ ok: true, headers: { get: () => '2097153' }, text: async () => '{}' }),
    async () => ({ ok: true, text: async () => ' '.repeat(2097153) })
  ]) {
    current = failed;
    clock += 600000;
    const state = await controller.refresh();
    assert.deepEqual(state.data, first.data);
    assert.equal(state.revision, first.revision);
    assert.equal(state.lastReceivedAt, first.lastReceivedAt);
    assert.notEqual(state.lastAttemptAt, first.lastAttemptAt);
    assert.match(state.error, /마지막 정상 자료 유지/);
    assert.doesNotMatch(state.error, /private|payload|unknownField/);
  }
  current = async () => response(original);
  const recovered = await controller.refresh();
  assert.equal(recovered.error, '');
  assert.notEqual(recovered.lastReceivedAt, first.lastReceivedAt);
});

test('overlapping requests share one promise; a completed pass releases the guard for the next pass', async () => {
  let release;
  let calls = 0;
  const controller = createController({ now: () => NOW, fetchImpl: () => {
    calls++;
    if (calls === 1) return new Promise(resolve => { release = resolve; });
    return Promise.resolve(response(fixture()));
  } });
  const first = controller.refresh();
  assert.equal(first, controller.refresh());
  assert.equal(calls, 1);
  release(response(fixture()));
  assert.equal((await first).error, '');
  assert.equal((await controller.refresh()).error, '');
  assert.equal(calls, 2);
});

test('a timed-out request aborts and leaves the previous source observation unchanged', async () => {
  let pending = false;
  let signal;
  const controller = createController({ now: () => NOW, timeoutMs: 10, fetchImpl: (_, options) => {
    if (!pending) return Promise.resolve(response(fixture()));
    signal = options.signal;
    return new Promise(() => {});
  } });
  const first = await controller.refresh();
  pending = true;
  const state = await controller.refresh();
  assert.equal(signal.aborted, true);
  assert.deepEqual(state.data, first.data);
  assert.equal(state.lastReceivedAt, first.lastReceivedAt);
  assert.ok(state.error);
});

test('older publications and source clocks cannot replace a successful dataset', async () => {
  for (const mutate of [
    value => { value.publishedAt = '2026-11-04T05:59:00Z'; },
    value => { value.publishedAt = null; },
    value => { value.series[0].asOf = '2026-11-04T03:45:00Z'; value.series[0].points[0].at = value.series[0].asOf; },
    value => { value.series[0].observedAt = '2026-11-04T04:45:00Z'; },
    value => { value.events[0].observedAt = '2026-11-04T04:45:00Z'; }
  ]) {
    let payload = fixture();
    const controller = createController({ now: () => NOW, fetchImpl: async () => response(payload) });
    const first = await controller.refresh();
    payload = fixture();
    payload.publishedAt = '2026-11-04T06:15:00Z';
    mutate(payload);
    const next = await controller.refresh();
    assert.deepEqual(next.data, first.data);
    assert.equal(next.revision, first.revision);
    assert.ok(next.error);
  }
});

function historyFixture() {
  const value = fixture();
  value.series[0].points.unshift({ at: '2026-11-04T03:45:00Z', pct: 2 });
  return value;
}

async function transition(original, candidate) {
  let payload = original;
  const controller = createController({ now: () => NOW, fetchImpl: async () => response(payload) });
  const first = await controller.refresh();
  assert.equal(first.error, '', 'the original preservation fixture must be valid');
  payload = candidate;
  return { first, next: await controller.refresh() };
}

test('overlapping source points and series cannot be deleted, rewritten or replaced under a new ID', async () => {
  for (const mutate of [
    value => { value.series[0].points.shift(); },
    value => { value.series[0].points[0].pct = 99; },
    value => { value.series = []; },
    value => { value.series[0].id = 'replacement'; },
    value => { value.series[0].points = []; value.series[0].asOf = null; }
  ]) {
    const original = historyFixture();
    const candidate = copy(original);
    candidate.publishedAt = '2026-11-04T06:15:00Z';
    mutate(candidate);
    const { first, next } = await transition(original, candidate);
    assert.ok(next.error);
    assert.deepEqual(next.data, first.data);
    assert.equal(next.revision, first.revision);
    assert.equal(next.lastReceivedAt, first.lastReceivedAt);
  }
});

test('same series ID cannot silently change instrument, panel, baseline, provider or source', async () => {
  for (const [key, replacement] of [
    ['instrument', 'OTHER'], ['panel', 'indices'], ['basis', 'Different synthetic baseline'],
    ['provider', 'Different synthetic provider'], ['sourceUrl', 'https://www.kraken.com/']
  ]) {
    const original = historyFixture();
    const candidate = copy(original);
    candidate.publishedAt = '2026-11-04T06:15:00Z';
    candidate.series[0][key] = replacement;
    const { first, next } = await transition(original, candidate);
    assert.ok(next.error, `${key} replacement must require a new record ID`);
    assert.deepEqual(next.data, first.data);
  }
});

test('in-window event cannot disappear, change its identity or lose source verification', async () => {
  for (const mutate of [
    value => { value.events = []; },
    value => { value.events[0].id = 'replacement-event'; },
    value => { value.events[0].at = '2026-11-04T04:01:00Z'; },
    value => { value.events[0].type = 'official_certification'; },
    value => { value.events[0].sourceUrl = 'https://apnews.com/'; },
    value => { value.events[0].verification = 'unverified'; }
  ]) {
    const original = historyFixture();
    const candidate = copy(original);
    candidate.publishedAt = '2026-11-04T06:15:00Z';
    mutate(candidate);
    const { first, next } = await transition(original, candidate);
    assert.ok(next.error);
    assert.deepEqual(next.data, first.data);
    assert.equal(next.revision, first.revision);
  }
});

test('rolling windows may omit old points outside the new window while preserving its inclusive boundary', async () => {
  const original = historyFixture();
  const candidate = copy(original);
  candidate.publishedAt = '2026-11-04T06:15:00Z';
  Object.assign(candidate.window, { start: '2026-11-04T04:00:00Z', end: '2026-11-04T06:15:00Z' });
  candidate.series[0].points.shift(); // 03:45 is outside; 04:00 remains at the boundary.
  candidate.series[0].points.push({ at: '2026-11-04T04:15:00Z', pct: 3 });
  candidate.series[0].asOf = '2026-11-04T04:15:00Z';
  candidate.series[0].observedAt = '2026-11-04T05:15:00Z';
  const { first, next } = await transition(original, candidate);
  assert.equal(next.error, '');
  assert.deepEqual(next.data, candidate);
  assert.equal(next.revision, first.revision + 1);

  const removedBoundary = copy(candidate);
  removedBoundary.series[0].points.shift();
  const rejected = await transition(original, removedBoundary);
  assert.ok(rejected.next.error, 'the inclusive 04:00 boundary observation must not disappear');
});

test('a rolling window can omit whole series and events once every old observation is outside it', async () => {
  const original = historyFixture();
  const candidate = copy(original);
  candidate.publishedAt = '2026-11-04T06:15:00Z';
  Object.assign(candidate.window, { start: '2026-11-04T04:15:00Z', end: '2026-11-04T06:15:00Z' });
  candidate.series = [];
  candidate.events = [];
  const { first, next } = await transition(original, candidate);
  assert.equal(next.error, '');
  assert.deepEqual(next.data, candidate);
  assert.equal(next.revision, first.revision + 1);
});

test('replacement records can be appended with new IDs while preserving the original in-window evidence', async () => {
  const original = historyFixture();
  const candidate = copy(original);
  candidate.publishedAt = '2026-11-04T06:15:00Z';
  candidate.series.push({ ...copy(candidate.series[0]), id: 'new-source-record', provider: 'Other synthetic provider',
    sourceUrl: 'https://www.kraken.com/', basis: 'Separate synthetic baseline' });
  candidate.events.push({ ...copy(candidate.events[0]), id: 'separate-event-record', type: 'official_certification',
    sourceUrl: 'https://apnews.com/' });
  const { first, next } = await transition(original, candidate);
  assert.equal(next.error, '');
  assert.deepEqual(next.data, candidate);
  assert.equal(next.revision, first.revision + 1);
});

test('public fetch rejects unverified numeric reference data without enabling the local import bypass', async () => {
  const payload = fixture();
  payload.mode = 'reference';
  Object.assign(payload.series[0], { verification: 'unverified', redistribution: 'unverified', sourceUrl: null,
    provider: 'Unverified local reference', observedAt: null, delaySeconds: null });
  payload.events = [];
  const controller = createController({ now: () => NOW, fetchImpl: async () => response(payload) });
  const state = await controller.refresh();
  assert.equal(state.data, null);
  assert.equal(state.lastReceivedAt, null);
  assert.equal(state.revision, 0);
  assert.ok(state.error);
});

test('an empty unsupported manifest can load without inventing source or publication timestamps', async () => {
  const payload = fixture();
  Object.assign(payload, { mode: 'reference', publishedAt: null, series: [], events: [], stories: [] });
  const controller = createController({ now: () => NOW, fetchImpl: async () => response(payload) });
  const state = await controller.refresh();
  assert.equal(state.error, '');
  assert.deepEqual(state.data, payload);
  assert.equal(state.data.publishedAt, null);
  assert.equal(state.lastReceivedAt, new Date(NOW).toISOString());
});

test('native streaming reads enforce the byte limit and cancel oversized content', async () => {
  let canceled = false;
  let unlocked = false;
  const controller = createController({ now: () => NOW, fetchImpl: async () => ({
    ok: true, body: { getReader: () => ({
      read: async () => ({ done: false, value: new Uint8Array(2097153) }),
      cancel: async () => { canceled = true; }, releaseLock: () => { unlocked = true; }
    }) }
  }) });
  const state = await controller.refresh();
  assert.equal(canceled, true);
  assert.equal(unlocked, true);
  assert.equal(state.data, null);
  assert.ok(state.error);
});
