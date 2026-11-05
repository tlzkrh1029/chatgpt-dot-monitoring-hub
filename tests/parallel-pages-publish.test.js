'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { publishAndVerify, main, PUBLIC_PATH } = require('../scripts/request-parallel-pages-build.js');
const response = (value, status = 200) => ({ ok: status >= 200 && status < 300, status,
  json: async () => value, text: async () => typeof value === 'string' ? value : JSON.stringify(value) });
const options = { repository: 'owner/repo', token: 'test-token', expectedText: '{"schemaVersion":3,"kind":"index"}\n', pollMs: 0, sleep: async () => {}, waitAttempts: 2, attempts: 3, now: () => 123 };

test('verifies the public parallel index (data/parallel/index.json), not the retired data/parallel.json', async () => {
  assert.equal(PUBLIC_PATH, 'data/parallel/index.json');
  const calls = [];
  const result = await publishAndVerify({ ...options, fetchImpl: async (url, init) => {
    calls.push([url, init]); return response(options.expectedText);
  } });
  assert.equal(result.publicUrl, 'https://owner.github.io/repo/data/parallel/index.json');
  assert.equal(calls[0][0], 'https://owner.github.io/repo/data/parallel/index.json?verify=123-1');
});

test('matching public content avoids a duplicate Pages build and never transmits a token to the public site', async () => {
  const calls = [];
  const result = await publishAndVerify({ ...options, fetchImpl: async (url, init) => {
    calls.push([url, init]); return response(options.expectedText);
  } });
  assert.equal(result.alreadyPublished, true);
  assert.equal(result.requested, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1].headers.Authorization, undefined);
  assert.equal(calls[0][1].credentials, 'omit');
});

test('waits for the build that the push started before requesting one (security-5)', async () => {
  const calls = []; const sleeps = []; let publicReads = 0;
  const result = await publishAndVerify({ ...options, waitAttempts: 5, pollMs: 5000, sleep: async (ms) => { sleeps.push(ms); },
    fetchImpl: async (url, init) => {
      calls.push([url, init]);
      return response(++publicReads < 3 ? 'old data' : options.expectedText);
    } });
  assert.deepEqual({ alreadyPublished: result.alreadyPublished, requested: result.requested, checks: result.checks },
    { alreadyPublished: true, requested: false, checks: 3 });
  assert.ok(calls.every(([url]) => url.startsWith('https://owner.github.io/')), 'no GitHub API call while the push build may still deploy');
  assert.ok(calls.every(([, init]) => !init.headers.Authorization));
  assert.deepEqual(sleeps, [5000, 5000]);
});

test('requests a build only after the whole wait, exactly once, and only through the API', async () => {
  const order = []; let posted = false;
  const result = await publishAndVerify({ ...options, waitAttempts: 3, attempts: 4, fetchImpl: async (url, init) => {
    if (url.startsWith('https://owner.github.io/')) {
      order.push('public');
      assert.equal(init.headers.Authorization, undefined);
      return response(posted && order.filter((x) => x === 'public').length >= 5 ? options.expectedText : 'old data');
    }
    assert.ok(url.startsWith('https://api.github.com/repos/owner/repo/'));
    assert.equal(init.headers.Authorization, 'Bearer test-token');
    order.push(`${init.method} ${url.slice('https://api.github.com/repos/owner/repo'.length)}`);
    if (url.endsWith('/pages')) return response({ build_type: 'legacy', source: { branch: 'main', path: '/' } });
    if (init.method === 'POST') { posted = true; return response({ status: 'queued' }, 201); }
    return response({ status: 'building' });
  } });
  assert.equal(result.requested, true);
  assert.equal(result.alreadyPublished, false);
  assert.deepEqual(order.slice(0, 6), ['public', 'public', 'public', 'GET /pages', 'GET /pages/builds/latest', 'POST /pages/builds']);
  assert.equal(order.filter((x) => x.startsWith('POST')).length, 1);
});

test('the default wait before a build request is about 2.5 minutes', async () => {
  const sleeps = []; let posted = false;
  await publishAndVerify({ ...options, waitAttempts: undefined, pollMs: undefined, attempts: 2,
    sleep: async (ms) => { if (!posted) sleeps.push(ms); },
    fetchImpl: async (url, init) => {
      if (url.includes('github.io')) return response(posted ? options.expectedText : 'old data');
      if (url.endsWith('/pages')) return response({ source: { branch: 'main', path: '/' } });
      if (init.method === 'POST') { posted = true; return response({ status: 'queued' }, 201); }
      return response({ status: 'building' });
    } });
  const waited = sleeps.reduce((a, b) => a + b, 0);
  assert.ok(waited >= 120000 && waited <= 180000, `waited ${waited} ms before requesting a build`);
});

test('requests the existing branch build and confirms exact public bytes after old builds or caches', async () => {
  const calls = []; let publicReads = 0; let buildReads = 0;
  const result = await publishAndVerify({ ...options, fetchImpl: async (url, init) => {
    calls.push([url, init]);
    if (url.startsWith('https://owner.github.io/')) return response(++publicReads < 4 ? 'old data' : options.expectedText);
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
    if (url.includes('github.io')) return response(++publicReads === 5 ? options.expectedText : 'old data');
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
  await assert.rejects(publishAndVerify({ ...options, waitAttempts: 0, fetchImpl: async () => response('x') }), /wait attempts/);
});

test('the CLI verifies the index file it is given (the archive worktree copy) with the token kept off the public site', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-pages-'));
  try {
    const file = path.join(dir, 'index.json');
    const text = '{"schemaVersion":3,"kind":"index","sessions":[]}\n';
    fs.writeFileSync(file, text);
    const calls = []; const lines = [];
    const result = await main([file], { env: { GITHUB_REPOSITORY: 'owner/repo', GITHUB_TOKEN: 'secret-token' },
      log: (line) => lines.push(line), sleep: async () => {},
      fetchImpl: async (url, init) => { calls.push([url, init]); return response(text); } });
    assert.equal(result.alreadyPublished, true);
    assert.equal(calls.length, 1);
    assert.ok(calls[0][0].startsWith('https://owner.github.io/repo/data/parallel/index.json?verify='));
    assert.ok(!JSON.stringify(calls[0][1]).includes('secret-token'));
    assert.equal(JSON.parse(lines[0]).publicationVerified, true);
    await assert.rejects(main([file, file], { env: {} }), /Usage/);
    await assert.rejects(main([file], { env: { GITHUB_REPOSITORY: 'owner/repo' } }), /GITHUB_TOKEN is required/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
