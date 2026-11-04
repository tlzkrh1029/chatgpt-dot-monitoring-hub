'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createController } = require('../refresh-client.js');
const { freshness, CATEGORY_CONFIG } = require('../public-data.js');

const FIXED_NOW = Date.parse('2026-11-04T02:30:00Z');
const KEYS = Object.keys(CATEGORY_CONFIG);
const clone = value => structuredClone(value);
const baseline = () => JSON.parse(fs.readFileSync(path.join(__dirname, '../data.json'), 'utf8'));

function category(key, changes = {}) {
  return {
    schemaVersion: 1,
    category: key,
    publishedAt: '2026-11-04T02:05:00.000Z',
    observedAt: '2026-11-04T02:00:00.000Z',
    checkStatus: 'ok',
    headline: `Initial ${key}`,
    body: 'Public monitoring summary.',
    unknown: 'Independent confirmation remains pending.',
    gap: '',
    feed: [{ at: '2026-11-04T02:00:00.000Z', kind: '원장 기록', title: `Initial ${key}`, text: 'Public monitoring summary.' }],
    ...changes
  };
}

function harness(options = {}) {
  let clock = FIXED_NOW;
  const payloads = new Map([['data.json', baseline()], ...KEYS.map(key => [`data/${key}.json`, category(key)])]);
  const failures = new Map();
  const calls = [];
  const changes = [];
  const fetchImpl = async (url, init) => {
    const file = url.split('?')[0];
    calls.push({ url, init });
    const failure = failures.get(file);
    if (failure === 'network') throw new Error('offline');
    if (failure === 'hang') return new Promise(() => {});
    if (typeof failure === 'function') return failure(url, init);
    return {
      ok: failure !== 'http',
      json: async () => {
        if (failure === 'parse') throw new SyntaxError('Unexpected token');
        return clone(payloads.get(file));
      }
    };
  };
  const controller = createController({ fetchImpl, now: () => clock, onChange: value => changes.push(value), ...options });
  return { controller, payloads, failures, calls, changes, setClock: value => { clock = value; } };
}

const find = (snapshot, key) => snapshot.data.categories.find(item => item.key === key);

test('initial load and subsequent data-only publication update the composed dashboard', async () => {
  const h = harness();
  const original = clone(h.payloads.get('data.json'));
  const first = await h.controller.refresh();
  assert.equal(first.data.categories.length, 5);
  assert.equal(find(first, 'macro').headline, 'Initial macro');
  assert.deepEqual(first.data.setting, original.setting);
  for (const item of original.feed) assert.ok(first.data.feed.some(row => row.at === item.at && row.category === item.category && row.text === item.text));
  h.payloads.set('data/macro.json', category('macro', {
    publishedAt: '2026-11-04T02:20:00Z', observedAt: '2026-11-04T02:15:00Z', headline: 'Updated macro'
  }));
  const second = await h.controller.refresh();
  assert.equal(find(second, 'macro').headline, 'Updated macro');
  assert.equal(find(second, 'election').headline, 'Initial election');
  assert.ok(second.revision > first.revision);
  assert.equal(h.changes.length, 2);
});

test('requests omit credentials and bypass caches with a different nonce on every pass', async () => {
  const h = harness();
  await h.controller.refresh();
  await h.controller.refresh();
  assert.equal(h.calls.length, 12);
  for (const call of h.calls) {
    assert.equal(call.init.credentials, 'omit');
    assert.equal(call.init.cache, 'no-store');
    assert.ok(call.init.signal instanceof AbortSignal);
    assert.match(call.url, /\?v=/);
  }
  assert.notEqual(h.calls[0].url, h.calls[6].url);
});

test('clock-based staleness uses observations, including the slower X schedule', async () => {
  const h = harness();
  const first = await h.controller.refresh();
  assert.equal(freshness(first.data, FIXED_NOW).staleKeys.length, 0);
  const later = FIXED_NOW + 2 * 60 * 60 * 1000;
  h.setClock(later);
  const second = await h.controller.refresh();
  assert.equal(find(second, 'macro').observedAt, find(first, 'macro').observedAt);
  assert.equal(second.revision, first.revision);
  assert.ok(Date.parse(second.statuses.macro.lastSuccessAt) > Date.parse(first.statuses.macro.lastSuccessAt));
  const status = freshness(second.data, later);
  for (const key of ['macro', 'election', 'security', 'onchain']) assert.ok(status.staleKeys.includes(key));
  assert.ok(!status.staleKeys.includes('xr'));
  assert.ok(freshness(second.data, FIXED_NOW + 6 * 60 * 60 * 1000).staleKeys.includes('xr'));
});

test('one failed category retains its last-good value while another category updates', async () => {
  const h = harness();
  const first = await h.controller.refresh();
  h.failures.set('data/macro.json', 'network');
  h.payloads.set('data/election.json', category('election', { publishedAt: '2026-11-04T02:20:00Z', headline: 'Election changed' }));
  const second = await h.controller.refresh();
  assert.deepEqual(find(second, 'macro'), find(first, 'macro'));
  assert.equal(find(second, 'election').headline, 'Election changed');
  assert.ok(second.statuses.macro.error);
  assert.equal(second.statuses.election.error, '');
  h.failures.delete('data/macro.json');
  assert.equal((await h.controller.refresh()).statuses.macro.error, '');
});

test('malformed JSON and unknown schema fields preserve the previous category', async () => {
  const h = harness();
  const first = await h.controller.refresh();
  h.failures.set('data/macro.json', 'parse');
  h.payloads.set('data/security.json', category('security', { accountDetails: 'must never appear' }));
  const second = await h.controller.refresh();
  assert.deepEqual(find(second, 'macro'), find(first, 'macro'));
  assert.deepEqual(find(second, 'security'), find(first, 'security'));
  assert.ok(second.statuses.macro.error);
  assert.ok(second.statuses.security.error);
  assert.ok(!JSON.stringify(second.data).includes('must never appear'));
});

test('missing and malformed base data preserve existing history and settings', async () => {
  const h = harness();
  const first = await h.controller.refresh();
  h.failures.set('data.json', 'http');
  const failedFetch = await h.controller.refresh();
  assert.deepEqual(failedFetch.data, first.data);
  assert.ok(failedFetch.baseError);
  h.failures.delete('data.json');
  h.payloads.set('data.json', { generatedAt: 'not-a-date', categories: [] });
  const malformed = await h.controller.refresh();
  assert.deepEqual(malformed.data, first.data);
  assert.ok(malformed.baseError);
});

test('failure on the first load remains empty instead of inventing monitoring data', async () => {
  const h = harness();
  h.failures.set('data.json', 'network');
  const result = await h.controller.refresh();
  assert.equal(result.data, null);
  assert.ok(result.baseError);
});

test('a newer valid base observation survives an unavailable older category overlay', async () => {
  const h = harness();
  await h.controller.refresh();
  const newerBase = clone(h.payloads.get('data.json'));
  newerBase.generatedAt = '2026-11-04T02:25:00Z';
  newerBase.latestRunAt = '2026-11-04T02:15:00Z';
  const macro = newerBase.categories.find(item => item.key === 'macro');
  macro.lastCheckAt = '2026-11-04T02:15:00Z';
  macro.headline = 'Newer validated base macro';
  h.payloads.set('data.json', newerBase);
  h.failures.set('data/macro.json', 'network');
  const result = await h.controller.refresh();
  assert.equal(find(result, 'macro').headline, 'Newer validated base macro');
  assert.equal(find(result, 'macro').lastCheckAt, '2026-11-04T02:15:00Z');
  assert.ok(result.statuses.macro.error);
  assert.equal(find(result, 'election').headline, 'Initial election');
  h.failures.delete('data/macro.json');
  h.payloads.set('data/macro.json', category('macro', {
    publishedAt: '2026-11-04T02:26:00Z', observedAt: '2026-11-04T02:20:00Z', headline: 'Recovered category macro'
  }));
  const recovered = await h.controller.refresh();
  assert.equal(find(recovered, 'macro').headline, 'Recovered category macro');
  assert.equal(recovered.statuses.macro.error, '');
});

test('wrong category identity, observation rollback, and publication rollback are rejected', async () => {
  const h = harness();
  const first = await h.controller.refresh();
  h.payloads.set('data/macro.json', category('election'));
  h.payloads.set('data/election.json', category('election', { observedAt: '2026-11-04T01:00:00Z' }));
  h.payloads.set('data/security.json', category('security', { publishedAt: '2026-11-04T02:01:00Z' }));
  const second = await h.controller.refresh();
  for (const key of ['macro', 'election', 'security']) {
    assert.deepEqual(find(second, key), find(first, key));
    assert.ok(second.statuses[key].error);
  }
});

test('failed check publication cannot advance the last actual observation', async () => {
  const h = harness();
  const first = await h.controller.refresh();
  h.payloads.set('data/macro.json', category('macro', {
    publishedAt: '2026-11-04T02:20:00Z', observedAt: '2026-11-04T02:15:00Z', checkStatus: 'error', gap: 'Public source unavailable.'
  }));
  const failed = await h.controller.refresh();
  assert.deepEqual(find(failed, 'macro'), find(first, 'macro'));
  assert.ok(failed.statuses.macro.error);
  h.payloads.set('data/macro.json', category('macro', {
    publishedAt: '2026-11-04T02:20:00Z', observedAt: '2026-11-04T02:00:00Z', checkStatus: 'error', gap: 'Public source unavailable.'
  }));
  const validError = await h.controller.refresh();
  assert.equal(validError.statuses.macro.error, '');
  assert.equal(find(validError, 'macro').checkStatus, 'error');
  assert.equal(Date.parse(find(validError, 'macro').observedAt), Date.parse(find(first, 'macro').observedAt));
});

test('overlapping refresh calls share one pass and cannot race older values over newer values', async () => {
  const h = harness();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  h.failures.set('data/macro.json', async () => {
    await gate;
    return { ok: true, json: async () => category('macro') };
  });
  const first = h.controller.refresh();
  const overlapping = h.controller.refresh();
  assert.strictEqual(first, overlapping);
  assert.equal(h.calls.length, 6);
  release();
  await first;
  assert.equal(h.changes.length, 1);
  h.failures.delete('data/macro.json');
  h.payloads.set('data/macro.json', category('macro', { publishedAt: '2026-11-04T02:20:00Z', headline: 'Latest macro' }));
  assert.equal(find(await h.controller.refresh(), 'macro').headline, 'Latest macro');
  assert.equal(h.calls.length, 12);
});

test('timed-out requests are aborted and other categories remain available', async () => {
  const h = harness({ timeoutMs: 15 });
  h.failures.set('data/macro.json', 'hang');
  const result = await h.controller.refresh();
  const call = h.calls.find(item => item.url.startsWith('data/macro.json?'));
  assert.ok(call.init.signal.aborted);
  assert.ok(result.statuses.macro.error);
  assert.equal(find(result, 'election').headline, 'Initial election');
  h.failures.delete('data/macro.json');
  assert.equal((await h.controller.refresh()).statuses.macro.error, '');
});
