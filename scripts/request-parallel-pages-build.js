#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const digest = text => createHash('sha256').update(text, 'utf8').digest('hex');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

// A GITHUB_TOKEN push does not trigger the existing branch Pages build.
// Request that build explicitly; a successful API response is not a deployment receipt.
async function publishAndVerify({ repository, token, expectedText, fetchImpl = fetch,
  sleep = pause, pollMs = 5000, attempts = 48, now = Date.now } = {}) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository || '')) throw new Error('Invalid repository identifier');
  if (typeof token !== 'string' || !token.trim()) throw new Error('GITHUB_TOKEN is required');
  if (typeof expectedText !== 'string' || !expectedText) throw new Error('Expected publication is required');
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 120) throw new Error('Invalid verification attempts');
  const [owner, repo] = repository.split('/');
  const api = `https://api.github.com/repos/${repository}`;
  const publicUrl = `https://${owner.toLowerCase()}.github.io/${repo}/data/parallel.json`;
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
  if (await published()) return { alreadyPublished: true, publicUrl, sha256: expectedHash };
  const site = await github('/pages');
  if (site.build_type && site.build_type !== 'legacy') throw new Error('This publisher requires the existing branch-based Pages source');
  if (site.source?.branch !== 'main' || site.source?.path !== '/') throw new Error('Unexpected Pages source; configuration was not changed');
  const identity = build => build ? [build.id, build.commit, build.created_at].filter(value => value !== undefined).join('|') : '';
  const previousBuild = await github('/pages/builds/latest', 'GET', true);
  const previousIdentity = identity(previousBuild);
  await github('/pages/builds', 'POST');
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (await published()) return { alreadyPublished: false, publicUrl, sha256: expectedHash };
    const build = await github('/pages/builds/latest');
    // /latest can briefly remain the preceding failed build after a new POST.
    if (build.status === 'errored' && (!previousIdentity || identity(build) !== previousIdentity)) {
      throw new Error('GitHub Pages build failed; committed data remains available in Git');
    }
    if (attempt + 1 < attempts) await sleep(pollMs);
  }
  throw new Error('Pages publication was not verified before timeout; do not treat the commit as deployed');
}

async function main() {
  const result = await publishAndVerify({ repository: process.env.GITHUB_REPOSITORY, token: process.env.GITHUB_TOKEN,
    expectedText: fs.readFileSync(path.join(__dirname, '..', 'data', 'parallel.json'), 'utf8') });
  console.log(JSON.stringify({ publicationVerified: true, alreadyPublished: result.alreadyPublished, url: result.publicUrl, sha256: result.sha256 }));
}
if (require.main === module) main().catch(error => { console.error(`Pages publication failed: ${error.message}`); process.exitCode = 1; });
module.exports = { publishAndVerify, digest };
