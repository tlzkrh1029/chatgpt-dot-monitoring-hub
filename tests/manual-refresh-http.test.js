'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { createController } = require('../refresh-client.js');
const { bind } = require('../manual-refresh.js');
const { CATEGORY_CONFIG } = require('../public-data.js');

test('manual refresh reports real HTTP success, partial outages, parse errors and recovery without losing data', { timeout: 15000 }, async t => {
  const keys = Object.keys(CATEGORY_CONFIG);
  const paths = ['/data.json', ...keys.map(key => `/data/${key}.json`)];
  // Serve the current committed public documents verbatim; this test invents no observations.
  const files = new Map(paths.map(file => [file, fs.readFileSync(path.join(__dirname, '..', file.slice(1)), 'utf8')]));
  const documents = paths.map(file => JSON.parse(files.get(file)));
  let clock = Math.max(Date.now(), ...documents.map(document => Date.parse(document.publishedAt || document.generatedAt))) + 60000;
  const failures = new Map();
  const requests = [];
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    requests.push({ path: url.pathname, query: url.searchParams.get('v') });
    const failure = failures.get(url.pathname);
    response.writeHead(failure?.status || (files.has(url.pathname) ? 200 : 404), {
      'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'
    });
    response.end(failure?.body ?? files.get(url.pathname) ?? '{}');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));

  const buttonAttributes = new Map();
  const statusAttributes = new Map();
  const listeners = new Map();
  const button = {
    textContent: '새로고침',
    setAttribute: (key, value) => buttonAttributes.set(key, String(value)),
    removeAttribute: key => buttonAttributes.delete(key),
    addEventListener: (key, listener) => listeners.set(key, listener)
  };
  const status = {
    textContent: '', dataset: {},
    setAttribute: (key, value) => statusAttributes.set(key, String(value)),
    removeAttribute: key => statusAttributes.delete(key)
  };
  const published = [];
  const controller = createController({ baseUrl: `http://127.0.0.1:${server.address().port}/`,
    now: () => clock, timeoutMs: 2000, onChange: snapshot => published.push(snapshot) });
  bind({ button, status, controller, categoryKeys: keys, formatTime: iso => iso });

  let passes = 0;
  async function click(outcome, severity, expectedCount) {
    const before = requests.length;
    clock += 1000;
    const pending = listeners.get('click')();
    assert.equal(status.dataset.state, 'loading');
    assert.equal(status.dataset.outcome, 'pending');
    assert.doesNotMatch(status.textContent, /[✅❌]/u, 'new loading feedback must clear the previous outcome icon');
    assert.equal(buttonAttributes.get('aria-busy'), 'true');
    const snapshot = await pending;
    passes++;
    const actual = requests.slice(before);
    assert.equal(actual.length, 6, 'each real HTTP pass must request the base and all five independent files');
    assert.deepEqual(actual.map(request => request.path).sort(), [...paths].sort());
    assert.ok(actual.every(request => request.query), 'real requests must carry a cache-busting nonce');
    assert.equal(new Set(actual.map(request => request.query)).size, 1);
    if (before) assert.notEqual(actual[0].query, requests[before - 1].query);
    assert.equal(status.dataset.outcome, outcome);
    assert.equal(status.dataset.state, severity);
    assert.ok(status.textContent.includes(expectedCount));
    const icon = outcome === 'success' ? '✅' : '❌';
    assert.ok(status.textContent.endsWith(` ${icon}`));
    assert.ok(!status.textContent.includes(outcome === 'success' ? '❌' : '✅'));
    assert.ok(statusAttributes.get('aria-label').endsWith(outcome === 'success' ? '새로고침 성공' : '새로고침 실패'));
    assert.equal(button.textContent, '새로고침');
    assert.equal(buttonAttributes.get('aria-busy'), 'false');
    assert.equal(buttonAttributes.get('aria-disabled'), 'false');
    return snapshot;
  }

  assert.ok(documents.slice(1).some(document => document.checkStatus === 'partial'), 'current fixtures retain their genuine source-check caveats');
  const initial = await click('success', 'warning', '5/5');
  assert.match(status.textContent, /부분 확인/);
  assert.ok(initial.data.feed.length);
  const original = structuredClone(initial.data);

  failures.set('/data/macro.json', { status: 503, body: '{"error":"temporary outage"}' });
  const oneFailed = await click('failure', 'warning', '4/5');
  assert.ok(oneFailed.statuses.macro.error);
  assert.equal(oneFailed.baseError, '');
  assert.match(status.textContent, /마지막 정상/);
  assert.deepEqual(oneFailed.data, original);

  failures.clear();
  failures.set('/data/xr.json', { status: 200, body: '{ malformed JSON' });
  const malformed = await click('failure', 'warning', '4/5');
  assert.ok(malformed.statuses.xr.error);
  assert.equal(malformed.statuses.macro.error, '');
  assert.deepEqual(malformed.data, original);

  failures.clear();
  for (const file of paths) failures.set(file, { status: 503, body: '{"error":"temporary outage"}' });
  const allFailed = await click('failure', 'error', '0/5');
  assert.ok(allFailed.baseError);
  assert.ok(keys.every(key => allFailed.statuses[key].error));
  assert.match(status.textContent, /마지막 정상/);
  assert.deepEqual(allFailed.data, original);

  failures.clear();
  failures.set('/data.json', { status: 503, body: '{"error":"temporary outage"}' });
  const baseFailed = await click('failure', 'warning', '5/5');
  assert.ok(baseFailed.baseError);
  assert.ok(keys.every(key => !baseFailed.statuses[key].error));
  assert.match(status.textContent, /기본 자료 수신 실패/);
  assert.deepEqual(baseFailed.data, original);

  failures.clear();
  const recovered = await click('success', 'warning', '5/5');
  assert.equal(recovered.baseError, '');
  assert.ok(keys.every(key => !recovered.statuses[key].error));
  assert.deepEqual(recovered.data, original, 'receive attempts must never advance source observation times or alter history');
  assert.equal(passes, 6);
  assert.equal(requests.length, 36);
  assert.equal(published.length, passes);
});
