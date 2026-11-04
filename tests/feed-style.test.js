'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { lintRecord, selectRecords } = require('../scripts/lint-feed-style.js');

const rules = record => lintRecord({ at: '2026-11-04T11:00:00Z', kind: '새 사실', title: '제목', text: '본문이다.', ...record })
  .map(warning => warning.rule);

test('a record written to the guide passes every style rule', () => {
  assert.deepEqual(rules({
    kind: '새 사실',
    title: 'Kansas 주지사 경합, 주정부 집계도 Holscher 5,557표 우세',
    text: 'Kansas 주정부 비공식 집계에서 Holscher 후보는 546,587표, Masterson 후보는 541,030표를 얻었다. '
      + '이 수치는 DDHQ 집계와 같다. 제9연방항소법원 명령과는 관계가 없다.',
    evidence: '한국시간 20:06~20:08에 주정부 결과 페이지와 DDHQ 개별 페이지를 조회했다.',
  }), []);
});

test('glued numbers and time zones, dated titles and em dashes are reported', () => {
  assert.deepEqual(rules({ title: '11/4 19:53 KST — 일간 기준 상승', text: 'DDHQ 하원241석이다. 조회는 10:53UTC였다.' }),
    ['spacing-number', 'spacing-timezone', 'title-time', 'em-dash']);
  // An ordinal such as 제9 is standard spacing, not a glued number.
  assert.deepEqual(rules({ text: '제9연방항소법원이 명령을 냈다.' }), []);
});

test('noun endings, chained interpuncts, long bodies, long evidence and excess precision are reported', () => {
  assert.ok(rules({ text: '공식 운영 변화 미확인.' }).includes('noun-ending'));
  assert.ok(rules({ title: 'A·B·C·D 유지' }).includes('title-dots'));
  assert.ok(rules({ text: 'A·B·C·D·E는 같다.' }).includes('sentence-dots'));
  assert.ok(rules({ text: '하나다. 둘이다. 셋이다. 넷이다. 다섯이다.' }).includes('text-length'));
  assert.ok(rules({ evidence: '가'.repeat(251) }).includes('evidence-length'));
  assert.ok(rules({ text: '10:47:58.559 UTC 값이다.' }).includes('precision'));
  assert.ok(rules({ text: '시가 대비 +1.4490%다.' }).includes('precision'));
  assert.ok(!rules({ text: '시가 대비 1.45% 올랐다.' }).includes('precision'));
});

test('kinds outside the fixed vocabulary are reported and the newest run is selected by default', () => {
  assert.ok(rules({ kind: '가격·페그 관찰' }).includes('kind-vocabulary'));
  assert.ok(!rules({ kind: '변화 없음' }).includes('kind-vocabulary'));
  const feed = [{ at: '2026-11-04T10:00:00Z' }, { at: '2026-11-04T11:00:00Z' }, { at: '2026-11-04T11:00:00.000Z' }];
  assert.deepEqual(selectRecords(feed, false), feed.slice(1));
  assert.deepEqual(selectRecords(feed, true), feed);
  assert.deepEqual(selectRecords([], false), []);
});
