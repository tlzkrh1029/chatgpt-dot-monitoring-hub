#!/usr/bin/env node
'use strict';
/* Confirms that GitHub Pages serves the parallel timeline index the workflow just archived to main.
 *
 * Usage: node scripts/request-parallel-pages-build.js [INDEX_FILE]
 *   INDEX_FILE: the index.json that was pushed (default data/parallel/index.json); the collect workflow passes
 *   the archive worktree's copy. Needs GITHUB_REPOSITORY and GITHUB_TOKEN (Pages API only).
 */
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

// The archive step rewrites the index whenever it pushes, so its bytes identify the deployed commit.
const PUBLIC_PATH = 'data/parallel/index.json';
const digest = text => createHash('sha256').update(text, 'utf8').digest('hex');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

// A GITHUB_TOKEN push to main appears to start the branch Pages build by itself (run history: one bot push got
// two builds for a single POST). So the public index is polled first (waitAttempts x pollMs, about 2.5 minutes)
// and a build is requested only if the public copy still differs. A successful API response is not a deployment
// receipt; only the exact public bytes are. The token goes to api.github.com only, never to the public site.
async function publishAndVerify({ repository, token, expectedText, fetchImpl = fetch,
  sleep = pause, pollMs = 5000, waitAttempts = 30, attempts = 48, now = Date.now } = {}) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository || '')) throw new Error('Invalid repository identifier');
  if (typeof token !== 'string' || !token.trim()) throw new Error('GITHUB_TOKEN is required');
  if (typeof expectedText !== 'string' || !expectedText) throw new Error('Expected publication is required');
  if (!Number.isInteger(waitAttempts) || waitAttempts < 1 || waitAttempts > 120) throw new Error('Invalid wait attempts');
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 120) throw new Error('Invalid verification attempts');
  const [owner, repo] = repository.split('/');
  const api = `https://api.github.com/repos/${repository}`;
  const publicUrl = `https://${owner.toLowerCase()}.github.io/${repo}/${PUBLIC_PATH}`;
  const expectedHash = digest(expectedText);
  let serial = 0;
  async function published() {
    try {
      const response = await fetchImpl(`${publicUrl}?verify=${now()}-${++serial}`, {
        headers: { Accept: 'application/json' }, cache: 'no-store', credentials: 'omit',
        signal: AbortSignal.timeout(15000)
      });
      if (!response.ok) return false;
      const value = await response.text();
      return value.length <= 2 * 1024 * 1024 && digest(value) === expectedHash;
    } catch (_) { return false; }
  }
  async function github(suffix, method = 'GET', allowMissing = false) {
    const response = await fetchImpl(api + suffix, {
      method, headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28' }, signal: AbortSignal.timeout(15000)
    });
    if (allowMissing && response.status === 404) return null;
    if (!response.ok) throw new Error(`GitHub Pages ${method} failed (HTTP ${response.status})`);
    return response.json();
  }
  // 1. Wait for the build that the push itself started.
  for (let check = 1; check <= waitAttempts; check++) {
    if (await published()) return { alreadyPublished: true, requested: false, checks: check, publicUrl, sha256: expectedHash };
    if (check < waitAttempts) await sleep(pollMs);
  }
  // 2. Still different: request the existing branch build once, then poll until the exact bytes are public.
  const site = await github('/pages');
  if (site.build_type && site.build_type !== 'legacy') throw new Error('This publisher requires the existing branch-based Pages source');
  if (site.source?.branch !== 'main' || site.source?.path !== '/') throw new Error('Unexpected Pages source; configuration was not changed');
  const identity = build => build ? [build.id, build.commit, build.created_at].filter(value => value !== undefined).join('|') : '';
  const previousBuild = await github('/pages/builds/latest', 'GET', true);
  const previousIdentity = identity(previousBuild);
  await github('/pages/builds', 'POST');
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (await published()) return { alreadyPublished: false, requested: true, checks: waitAttempts + attempt + 1, publicUrl, sha256: expectedHash };
    const build = await github('/pages/builds/latest');
    // /latest can briefly remain the preceding failed build after a new POST.
    if (build.status === 'errored' && (!previousIdentity || identity(build) !== previousIdentity)) {
      throw new Error('GitHub Pages build failed; committed data remains available in Git');
    }
    if (attempt + 1 < attempts) await sleep(pollMs);
  }
  throw new Error('Pages publication was not verified before timeout; do not treat the commit as deployed');
}

/** CLI. io (tests): {env, fetchImpl, sleep, log} replace process.env, fetch, the poll pause and console.log. */
async function main(argv = process.argv.slice(2), io = {}) {
  const env = io.env || process.env;
  const log = io.log || (line => console.log(line));
  if (argv.length > 1 || (argv[0] || '').startsWith('-')) throw new Error('Usage: request-parallel-pages-build.js [INDEX_FILE]');
  const file = argv[0] ? path.resolve(argv[0]) : path.join(__dirname, '..', ...PUBLIC_PATH.split('/'));
  const result = await publishAndVerify({ repository: env.GITHUB_REPOSITORY, token: env.GITHUB_TOKEN,
    expectedText: fs.readFileSync(file, 'utf8'), ...(io.fetchImpl ? { fetchImpl: io.fetchImpl } : {}),
    ...(io.sleep ? { sleep: io.sleep } : {}) });
  log(JSON.stringify({ publicationVerified: true, alreadyPublished: result.alreadyPublished, requested: result.requested,
    checks: result.checks, url: result.publicUrl, sha256: result.sha256 }));
  return result;
}
if (require.main === module) main().catch(error => { console.error(`Pages publication failed: ${error.message}`); process.exitCode = 1; });
module.exports = { publishAndVerify, main, digest, PUBLIC_PATH };
