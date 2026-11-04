'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { publishAndVerify } = require('../scripts/request-parallel-pages-build.js');
const response = (value, status = 200) => ({ ok: status >= 200 && status < 300, status,
  json: async () => value, text: async () => typeof value === 'string' ? value : JSON.stringify(value) });
const options = { repository: 'owner/repo', token: 'test-token', expectedText: '{"schemaVersion":2}\n', pollMs: 0, sleep: async () => {}, attempts: 3, now: () => 123 };

test('matching public content avoids a duplicate Pages build and never transmits a token to the public site', async () => {
  const calls = [];
  const result = await publishAndVerify({ ...options, fetchImpl: async (url, init) => {
    calls.push([url, init]); return response(options.expectedText);
  } });
  assert.equal(result.alreadyPublished, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1].headers.Authorization, undefined);
  assert.equal(calls[0][1].credentials, 'omit');
});

test('requests the existing branch build and confirms exact public bytes after old builds or caches', async () => {
  const calls = []; let publicReads = 0; let buildReads = 0;
  const result = await publishAndVerify({ ...options, fetchImpl: async (url, init) => {
    calls.push([url, init]);
    if (url.startsWith('https://owner.github.io/')) return response(++publicReads < 3 ? 'old data' : options.expectedText);
    assert.equal(init.headers.Authorization, 'Bearer test-token');
    if (url.endsWith('/pages')) return response({ build_type: 'legacy', source: { branch: 'main', path: '/' } });
    if (init.method === 'POST') return response({ status: 'queued' }, 201);
    return response({ status: ++buildReads === 1 ? 'building' : 'built' });
  } });
  assert.equal(result.alreadyPublished, false);
  assert.equal(calls.filter(([, init]) => init.method === 'POST').length, 1);
  assert.equal(buildReads, 2);
  assert.ok(calls.filter(([url]) => url.includes('github.io')).every(([, init]) => !init.headers.Authorization));
});

test('a successful build with stale public data is not reported as deployed', async () => {
  await assert.rejects(publishAndVerify({ ...options, fetchImpl: async (url, init) => {
    if (url.startsWith('https://owner.github.io/')) return response('old data');
    if (url.endsWith('/pages')) return response({ source: { branch: 'main', path: '/' } });
    return response({ status: init.method === 'POST' ? 'queued' : 'built' });
  } }), /not verified before timeout/);
});

test('a previous failed build returned by latest is ignored until the requested build and public file appear', async () => {
  let publicReads = 0, buildReads = 0;
  const result = await publishAndVerify({ ...options, attempts: 4, fetchImpl: async (url, init) => {
    if (url.includes('github.io')) return response(++publicReads === 4 ? options.expectedText : 'old data');
    if (url.endsWith('/pages')) return response({ source: { branch: 'main', path: '/' } });
    if (init.method === 'POST') return response({ status: 'queued' }, 201);
    return response(++buildReads <= 2 ? { id: 10, commit: 'old', status: 'errored' } : { id: 11, commit: 'new', status: 'built' });
  } });
  assert.equal(result.alreadyPublished, false);
  assert.equal(buildReads, 3);
});

test('unexpected Pages configuration stops before a build or settings mutation', async () => {
  let posts = 0;
  await assert.rejects(publishAndVerify({ ...options, fetchImpl: async (url, init) => {
    if (url.includes('github.io')) return response('old data');
    if (init.method !== 'GET') posts++;
    return response({ build_type: 'workflow', source: { branch: 'main', path: '/' } });
  } }), /existing branch-based/);
  assert.equal(posts, 0);
});

test('permission failures and build failures remain explicit without leaking the token', async () => {
  await assert.rejects(publishAndVerify({ ...options, fetchImpl: async url =>
    url.includes('github.io') ? response('old data') : response({}, 403) }), error => {
      assert.match(error.message, /HTTP 403/); assert.ok(!error.message.includes(options.token)); return true;
    });
  await assert.rejects(publishAndVerify({ ...options, fetchImpl: async (url, init) => {
    if (url.includes('github.io')) return response('old data');
    if (url.endsWith('/pages')) return response({ source: { branch: 'main', path: '/' } });
    return response({ status: init.method === 'POST' ? 'queued' : 'errored' });
  } }), /build failed/);
});
