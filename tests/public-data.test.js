'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const M = require('../public-data.js');
const original = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data.json'), 'utf8'));
const NOW = Date.parse('2026-11-04T10:00:00Z');
const copy = (v) => JSON.parse(JSON.stringify(v));
function envelope(key = 'macro') {
  const c = original.categories.find((item) => item.key === key);
  return { schemaVersion: 1, category: key, publishedAt: '2026-11-04T09:10:00Z',
    observedAt: '2026-11-04T09:00:00Z', checkStatus: 'ok', headline: 'Public check summary',
    body: 'Evidence checked without a new material fact.', unknown: c.unknown, gap: '',
    feed: [{ at: '2026-11-04T09:00:00Z', kind: '참고', title: 'Public check', text: 'No new material fact.' }] };
}
test('existing snapshot validates unchanged and validation returns an independent value', () => {
  const result = M.validateData(original, { now: NOW });
  assert.deepEqual(result, original);
  result.categories[0].body = 'Changed outside the source';
  assert.notEqual(result.categories[0].body, original.categories[0].body);
});
test('unknown fields, missing or duplicate categories and cross-category records are rejected', () => {
  const mutate = [
    (d) => { d.privateNotes = 'unrecognized'; },
    (d) => { d.setting.account = 'unrecognized'; },
    (d) => { d.categories[0].source = 'unrecognized'; },
    (d) => { d.categories.pop(); },
    (d) => { d.categories[1] = copy(d.categories[0]); },
    (d) => { d.categories[0].key = 'other'; },
    (d) => { d.feed[0].category = 'other'; },
    (d) => { d.categories[0].name = 'Changed identity'; },
    (d) => { d.links.ledger = 'private'; },
    (d) => { d.events.push({ source: 'private' }); }
  ];
  for (const change of mutate) {
    const data = copy(original); change(data);
    assert.throws(() => M.validateData(data, { now: NOW }));
  }
});
test('invalid timestamps, future checks and inconsistent observation/publication clocks are rejected', () => {
  const mutations = [
    (d) => { d.generatedAt = '2026-02-30T15:23:00Z'; },
    (d) => { d.generatedAt = 'tomorrow'; },
    (d) => { d.generatedAt = '2026-11-05T15:23:00Z'; },
    (d) => { d.categories[0].lastCheckAt = new Date(Date.parse(d.generatedAt) + 60000).toISOString(); },
    (d) => { d.latestRunAt = '2026-11-03T15:21:00Z'; },
    (d) => {
      const observation = d.feed.find((f) => f.category === 'macro' && (f.timeBasis || 'observation') === 'observation');
      observation.at = new Date(Date.parse(d.categories.find((c) => c.key === 'macro').lastCheckAt) + 60000).toISOString();
    }
  ];
  for (const change of mutations) {
    const data = copy(original); change(data);
    assert.throws(() => M.validateData(data, { now: NOW }));
  }
});
test('publication preserves actual observation time; a notification has an explicit independent time basis', () => {
  const update = envelope();
  update.observedAt = original.categories[0].lastCheckAt;
  update.checkStatus = 'partial';
  update.gap = 'Migrated notification; no later source observation verified.';
  update.feed = [{ at: '2026-11-04T09:00:00Z', timeBasis: 'notification', kind: '참고',
    title: 'Previously delivered notification', text: 'The notification is later than the last source check.',
    evidence: '기존 알림 이관', sources: ['https://x.com/example/status/123456789'] }];
  assert.deepEqual(M.validateCategory(update, 'macro', { now: NOW }), update);
  const result = M.composeData(original, [update]);
  assert.equal(result.generatedAt, update.publishedAt);
  assert.equal(result.categories[0].lastCheckAt, original.categories[0].lastCheckAt);
  assert.equal(result.latestRunAt, original.latestRunAt);
  assert.equal(M.freshness(result, NOW).categories[0].stale, true);
  update.feed[0].timeBasis = 'observation';
  assert.throws(() => M.validateCategory(update, 'macro', { now: NOW }), /evidence check/);
});
test('public source allowlist accepts public documents and post URLs and rejects private/account/credential URLs', () => {
  for (const url of ['https://www.federalreserve.gov/newsevents/pressreleases.htm',
    'https://github.com/example/public-repo/blob/main/README.md', 'https://x.com/example/status/12345']) {
    assert.equal(M.publicUrl(url), url);
  }
  for (const url of ['http://example.org/report', 'https://secret.notion.site/page', 'https://www.notion.so/page',
    'https://localhost/report', 'https://127.0.0.1/report', 'https://10.0.0.1/report', 'https://[::1]/report',
    'https://service.internal/report', 'https://service/report', 'https://user:secret@example.org/report',
    'https://example.org:8443/report', 'https://x.com/example', 'https://x.com/settings/account',
    'https://example.org/account/balance', 'https://example.org/report?access_token=secret',
    'https://example.org/report?api_key=secret', 'https://example.org/report#access_token=secret',
    'https://app.notion.com/page', 'https://notion.com/page', 'https://docs.google.com/document/d/private',
    'https://drive.google.com/file/d/private', 'https://workspace.slack.com/archives/private',
    'https://chatgpt.com/c/private', 'https://dropbox.com/s/private', 'https://app.box.com/s/private',
    'https://onedrive.live.com/private', 'https://example.org/a%63count/balance',
    'https://example.org/%2561ccount/balance', 'https://example.org/%252561ccount/balance',
    'https://example.org/records%2Fsettings', 'https://example.org/records%5caccount',
    'https://example.org/account%00', 'https://example.org/redirect?url=https%3A%2F%2Fprivate.notion.so%2Fpage',
    'https://example.org/redirect?url=https%253A%252F%252Fprivate.notion.so%252Fpage',
    'https://example.org/redirect?next=%2F%2Fprivate.notion.so%2Fpage',
    'https://example.org/redirect?next=private.notion.com%2Fpage',
    'https://example.org/report?api%255Fkey=private',
    'https://example.org/redirect?url=https%3A%2F%2Fpublic.example.org%2Fpage']) assert.throws(() => M.publicUrl(url));
});
test('prose rejects private links, contact details and credential-like material and no raw value leaks into errors', () => {
  for (const secret of ['https://private.notion.so/page', 'someone@example.org',
    'api_key=supersecret', 'ghp_abcdefghijklmnopqrstuvwxy']) {
    const update = envelope(); update.body = secret;
    assert.throws(() => M.validateCategory(update, 'macro', { now: NOW }), (error) => !error.message.includes(secret));
  }
});
test('category envelopes require owned categories, strict fields, status gaps and safe chronology', () => {
  assert.doesNotThrow(() => M.validateCategory(envelope(), 'macro', { now: NOW }));
  assert.throws(() => M.validateCategory(envelope(), 'election', { now: NOW }), /owned category/);
  const changes = [
    (u) => { u.setting = original.setting; },
    (u) => { u.feed[0].category = 'security'; },
    (u) => { u.feed[0].privateNotes = 'forbidden'; },
    (u) => { u.checkStatus = 'complete'; },
    (u) => { u.checkStatus = 'error'; },
    (u) => { u.observedAt = '2026-11-04T09:11:00Z'; },
    (u) => { u.feed[0].timeBasis = 'publication'; },
    (u) => { u.feed[0].at = '2026-11-04T09:01:00Z'; },
    (u) => { u.feed[0].sources = ['https://private.notion.so/page']; },
    (u) => { u.schemaVersion = 2; }
  ];
  for (const change of changes) {
    const update = envelope(); change(update);
    assert.throws(() => M.validateCategory(update, 'macro', { now: NOW }));
  }
});
test('notification precision is preserved and rolling category history is bounded', () => {
  const update = envelope();
  update.feed[0].timeBasis = 'notification';
  update.feed[0].at = '2026-11-04T09:00:00.123456Z';
  const result = M.validateCategory(update, 'macro', { now: NOW });
  assert.equal(result.feed[0].at, '2026-11-04T09:00:00.123456Z');
  assert.equal(M.composeData(original, [result]).feed[0].at, '2026-11-04T09:00:00.123456Z');
  update.feed = Array.from({ length: 201 }, () => copy(update.feed[0]));
  assert.throws(() => M.validateCategory(update, 'macro', { now: NOW }), /size limit/);
});
test('composition preserves all history, setting and other categories without mutating inputs', () => {
  const base = M.validateData(original, { now: NOW });
  const update = M.validateCategory(envelope(), 'macro', { now: NOW });
  const before = copy(base); const beforeUpdate = copy(update);
  const result = M.composeData(base, [update]);
  assert.deepEqual(base, before); assert.deepEqual(update, beforeUpdate);
  assert.deepEqual(result.setting, base.setting);
  for (const item of base.feed) assert.ok(result.feed.some((f) => JSON.stringify(f) === JSON.stringify(item)));
  assert.equal(result.feed.length, base.feed.length + 1);
  for (const key of ['election', 'security', 'xr', 'onchain']) {
    assert.deepEqual(result.categories.find((c) => c.key === key), base.categories.find((c) => c.key === key));
    assert.deepEqual(result.gaps.find((g) => g.category === key), base.gaps.find((g) => g.category === key));
  }
  const repeated = M.composeData(result, [update]);
  assert.deepEqual(repeated.feed, result.feed);
  const correction = copy(update); correction.feed[0].text = 'Corrected public summary.';
  assert.equal(M.composeData(result, [correction]).feed.length, result.feed.length + 1);
});
test('regressing evidence checks and duplicate writers fail instead of clobbering known data', () => {
  const older = envelope(); older.observedAt = '2026-11-03T14:00:00Z'; older.feed = [];
  assert.throws(() => M.composeData(original, [older]), /regress/);
  assert.throws(() => M.composeData(original, [envelope(), envelope()]), /duplicate/);
});
test('staleness advances with wall time even when publication advances and X uses its configured cadence', () => {
  const updates = Object.keys(M.CATEGORY_CONFIG).map((key) => envelope(key));
  const result = M.composeData(original, updates);
  const fresh = M.freshness(result, '2026-11-04T10:00:00Z');
  assert.equal(fresh.allFresh, true);
  assert.deepEqual(fresh.staleKeys, []);
  const afterTwoHours = M.freshness(result, '2026-11-04T11:00:00Z');
  assert.deepEqual(afterTwoHours.staleKeys, ['macro', 'election', 'security', 'onchain']);
  assert.equal(afterTwoHours.categories.find((c) => c.key === 'xr').stale, false);
  const afterSixHours = M.freshness(result, '2026-11-04T15:00:00Z');
  assert.equal(afterSixHours.staleKeys.length, 5);
  result.generatedAt = '2026-11-04T15:00:00Z';
  assert.equal(M.freshness(result, '2026-11-04T15:00:00Z').staleKeys.length, 5);
  assert.equal(M.freshness(result, '2026-11-04T08:59:00Z').categories[0].ageMs, 0);
});
