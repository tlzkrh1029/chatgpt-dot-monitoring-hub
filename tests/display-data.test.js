'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const V = require('../display-data.js');
const M = require('../public-data.js');
const { createController } = require('../refresh-client.js');

const NOW = Date.parse('2026-11-04T10:00:00Z');
const read = file => JSON.parse(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'));
const original = () => M.validateData(read('data.json'), { now: NOW });
const composeCurrent = () => M.composeData(original(), Object.keys(M.CATEGORY_CONFIG).map(key =>
  M.validateCategory(read(`data/${key}.json`), key, { now: NOW })));
const freeze = value => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};
const record = changes => ({ at: '2026-11-04T03:00:00Z', category: 'security', kind: '참고',
  title: 'Binance public update', text: 'The operator published an update.', ...changes });

test('four presentation categories retain five original identities, clocks and partial-check states', () => {
  const data = freeze(composeCurrent());
  const before = JSON.stringify(data);
  const groups = V.categories(data);
  assert.deepEqual(groups.map(group => group.key), ['macro', 'election', 'security', 'xr']);
  const security = groups.find(group => group.key === 'security');
  assert.equal(security.name, '크립토 보안·해킹');
  assert.deepEqual(security.members.map(member => member.key), ['security', 'onchain']);
  assert.equal(security.members[0].checkStatus, 'partial');
  assert.equal(security.members[1].checkStatus, 'partial');
  assert.notEqual(security.members[0].observedAt, security.members[1].observedAt);
  for (const source of data.categories) {
    const members = groups.flatMap(group => group.members).filter(member => member.key === source.key);
    assert.equal(members.length, 1);
    assert.strictEqual(members[0], source);
    for (const field of ['observedAt', 'publishedAt', 'checkStatus', 'unknown', 'gap'])
      assert.equal(members[0][field], source[field]);
  }
  assert.equal(JSON.stringify(data), before);
  assert.deepEqual(Object.keys(M.CATEGORY_CONFIG), ['macro', 'election', 'security', 'xr', 'onchain']);
});

test('the security filter includes both producers, with independent subtype labels and unchanged other filters', () => {
  const data = composeCurrent();
  const expected = data.feed.filter(row => row.category === 'security' || row.category === 'onchain');
  for (const filter of ['security', 'onchain'])
    assert.deepEqual(data.feed.filter(row => V.matches(row, filter)), expected);
  assert.deepEqual(data.feed.filter(row => V.matches(row, 'all')), data.feed);
  for (const key of ['macro', 'election', 'xr'])
    assert.deepEqual(data.feed.filter(row => V.matches(row, key)), data.feed.filter(row => row.category === key));
  assert.equal(V.subtype('security'), '사건·복구');
  assert.equal(V.subtype('onchain'), 'ZachXBT 조사·자금 추적');
  assert.equal(V.subtype('macro'), '');
});

test('grouping preserves every correction, evidence, source, time basis and raw category without mutating input', () => {
  const rows = freeze([
    record({ at: '2026-11-04T01:00:00Z', evidence: 'Operator statement', sources: ['https://www.binance.com/en/blog/one'] }),
    record({ at: '2026-11-04T01:03:00Z', category: 'onchain', evidence: 'Investigator claim', sources: ['https://t.me/investigations/375'] }),
    record({ text: 'Corrected scope; no independently confirmed total.', evidence: 'Correction', timeBasis: 'observation' }),
    record({ text: 'Original scope remains disputed.', evidence: 'Earlier report', timeBasis: 'notification' }),
    record({ text: 'Original scope remains disputed.', evidence: 'Different evidence', timeBasis: 'notification',
      sources: ['https://www.binance.com/en/blog/two'] }),
  ]);
  const before = JSON.stringify(rows);
  const groups = V.groupFeed(rows);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].label, 'Binance');
  assert.equal(groups[0].records.length, rows.length);
  assert.equal(JSON.stringify(rows), before);
  for (const row of rows) assert.equal(groups[0].records.filter(item => item === row).length, 1);
  assert.deepEqual(groups[0].records.map(row => Date.parse(row.at)),
    rows.map(row => Date.parse(row.at)).sort((a, b) => b - a));
  assert.equal(groups[0].records[0].text, rows[2].text);
  // The group names related coverage; it creates no merged article, incident count or financial total.
  assert.deepEqual(Object.keys(groups[0]).sort(), ['key', 'label', 'records']);
});

test('multi-subject roundups and conflicting title/body subjects are not folded into named coverage', () => {
  const rows = [
    record({ title: 'Binance and GitBook updates', text: 'Existing public reports.' }),
    record({ title: 'Binance update', text: 'Binance and GitBook remain under observation.' }),
    record({ title: 'Binance update', text: 'GitBook published a recovery statement.' }),
    record({ title: 'Public security roundup', text: 'BTCPay, Chainalysis and Mercado remain under observation.' }),
    record({ title: 'Binance update' }),
    record({ category: 'onchain', title: 'Binance follow-up', at: '2026-11-04T03:03:00Z' }),
  ];
  const groups = V.groupFeed(rows);
  const named = groups.filter(group => group.key);
  assert.equal(named.length, 1);
  assert.equal(named[0].key, 'binance');
  assert.deepEqual(new Set(named[0].records), new Set(rows.slice(4)));
  for (const row of rows.slice(0, 4)) {
    const group = groups.find(item => item.records.includes(row));
    assert.equal(group.key, '');
    assert.deepEqual(group.records, [row]);
  }
});

test('unrelated categories, quiet checks and unnamed investigations remain separate even when they mention a shared name', () => {
  const rows = [
    record({ category: 'macro' }),
    record({ isQuiet: true }),
    record({ category: 'onchain', title: 'EU investigation', text: 'Unconfirmed bank attribution.' }),
    record({ category: 'onchain', title: 'EU investigation', text: 'A later independent check remains incomplete.' }),
  ];
  const groups = V.groupFeed(rows);
  assert.equal(groups.length, rows.length);
  assert.ok(groups.every(group => group.key === '' && group.records.length === 1));
  assert.deepEqual(V.groupFeed([]), []);
});

test('actual composed publication history remains completely recoverable from presentation groups', () => {
  const data = freeze(composeCurrent());
  const before = JSON.stringify(data);
  const groups = V.groupFeed(data.feed);
  const flattened = groups.flatMap(group => group.records);
  assert.equal(flattened.length, data.feed.length);
  for (const row of data.feed) assert.equal(flattened.filter(candidate => candidate === row).length, 1);
  assert.ok(groups.some(group => group.key === 'gitbook' && group.records.length > 1));
  const roundup = data.feed.find(row => row.category === 'security' && row.at === '2026-11-04T02:35:15Z' && row.kind === '정기 관찰');
  assert.ok(roundup);
  assert.equal(groups.find(group => group.records.includes(roundup)).key, '');
  assert.equal(JSON.stringify(data), before);
});

test('security and onchain publications update independently inside the same four-category view', async () => {
  const payloads = new Map([['data.json', read('data.json')], ...Object.keys(M.CATEGORY_CONFIG)
    .map(key => [`data/${key}.json`, read(`data/${key}.json`)])]);
  const failures = new Set();
  const calls = [];
  // Real publisher files continue to advance. Synthetic follow-ups must be newer
  // than every loaded observation/publication, rather than fixed historical times.
  let clock = Math.max(NOW, ...Array.from(payloads.values(), value => Date.parse(value.publishedAt || value.generatedAt)));
  const controller = createController({ now: () => clock, fetchImpl: async url => {
    const file = url.split('?')[0]; calls.push(file);
    if (failures.has(file)) throw new Error('offline');
    return { ok: true, json: async () => structuredClone(payloads.get(file)) };
  } });
  const member = (snapshot, key) => V.categories(snapshot.data).find(group => group.key === 'security')
    .members.find(item => item.key === key);
  const first = await controller.refresh();
  const advance = (key, at, headline) => {
    const update = structuredClone(payloads.get(`data/${key}.json`));
    Object.assign(update, { publishedAt: at, observedAt: at, headline, checkStatus: 'partial', gap: 'Independent verification incomplete.' });
    update.feed.push({ at, kind: '참고', title: headline, text: 'Public follow-up.', evidence: 'Partial source check', sources: ['https://t.me/investigations/375'] });
    payloads.set(`data/${key}.json`, update);
  };
  clock += 60000;
  advance('onchain', new Date(clock).toISOString(), 'Updated investigator report');
  failures.add('data/security.json');
  const second = await controller.refresh();
  assert.deepEqual(member(second, 'security'), member(first, 'security'));
  assert.equal(member(second, 'onchain').headline, 'Updated investigator report');
  assert.ok(second.statuses.security.error);
  assert.equal(second.statuses.onchain.error, '');
  clock += 60000;
  advance('security', new Date(clock).toISOString(), 'Updated operator recovery report');
  failures.delete('data/security.json'); failures.add('data/onchain.json');
  const third = await controller.refresh();
  assert.equal(member(third, 'security').headline, 'Updated operator recovery report');
  assert.deepEqual(member(third, 'onchain'), member(second, 'onchain'));
  assert.equal(third.statuses.security.error, '');
  assert.ok(third.statuses.onchain.error);
  assert.equal(V.categories(third.data).length, 4);
  assert.equal(third.data.categories.length, 5);
  assert.deepEqual(new Set(calls), new Set(['data.json', ...Object.keys(M.CATEGORY_CONFIG).map(key => `data/${key}.json`)]));
  assert.equal(calls.length, 18);
  for (const row of first.data.feed) assert.ok(third.data.feed.some(candidate => JSON.stringify(candidate) === JSON.stringify(row)));
  const selected = third.data.feed.filter(row => V.matches(row, 'security'));
  assert.ok(selected.some(row => row.title === 'Updated operator recovery report'));
  assert.ok(selected.some(row => row.title === 'Updated investigator report'));
});
