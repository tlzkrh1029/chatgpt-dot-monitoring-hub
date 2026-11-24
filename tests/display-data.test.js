'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../public-data.js');
const V = require('../display-data.js');
const base = require('../data.json');
test('only the active publisher is accepted and displayed', () => {
  assert.deepEqual(Object.keys(M.CATEGORY_CONFIG), ['macro']);
  const data = M.validateData(base);
  const before = JSON.stringify(data);
  const groups = V.categories(data);
  assert.deepEqual(groups.map(g => g.key), ['macro']);
  assert.strictEqual(groups[0].members[0], data.categories[0]);
  assert.equal(JSON.stringify(data), before);
  assert.ok(data.feed.every(row => V.matches(row, 'macro')));
  assert.ok(data.gaps.every(row => row.category === 'macro'));
});
test('signal ordering and direct source links retain their reader-facing behavior', () => {
  const a = { at: '2026-11-04T00:00:00Z', category: 'macro', kind: '새 사실', title: 'A' };
  const b = { ...a, kind: '변화 없음', title: 'B' };
  assert.deepEqual([b,a].sort(V.compareRecords), [a,b]);
  assert.deepEqual(V.groupFeed([a,b]).flatMap(g => g.records), [a,b]);
  assert.equal(V.sourceInfo('https://www.okx.com/docs-v5/en/').name, 'OKX');
  assert.deepEqual(V.sourceSummary(['https://www.okx.com/a','https://www.okx.com/b']).names, ['OKX']);
});
