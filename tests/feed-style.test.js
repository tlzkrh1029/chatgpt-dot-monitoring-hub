'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { lintRecord, lintSummary, selectRecords } = require('../scripts/lint-feed-style.js');

const rules = record => lintRecord({ at: '2026-11-04T11:00:00Z', kind: '새 사실', title: '제목', text: '본문이다.', ...record })
  .map(warning => warning.rule);

test('a record written to the guide passes every style rule', () => {
  assert.deepEqual(rules({
    kind: '새 사실',
    title: 'Kansas 주지사 경합, 주정부 집계도 Holscher 5,557표 우세',
    text: 'Kansas 주정부 비공식 집계에서 Holscher 후보는 546,587표, Masterson 후보는 541,030표를 얻었다. '
      + '이 수치는 DDHQ 집계와 같다.\n\n제9연방항소법원 명령과는 관계가 없다.',
    evidence: '한국시간 20:06~20:08에 주정부 결과 페이지와 DDHQ 개별 페이지를 조회했다.',
  }), []);
});

test('glued numbers and time zones, dated titles and em dashes are reported in any field', () => {
  assert.deepEqual(rules({ title: '11/4 19:53 KST — 일간 기준 상승', text: 'DDHQ 하원241석이다. 조회는 10:53UTC였다.' }),
    ['spacing-number', 'spacing-timezone', 'title-time', 'em-dash']);
  // An ordinal such as 제9 is standard spacing, not a glued number.
  assert.deepEqual(rules({ text: '제9연방항소법원이 명령을 냈다.' }), []);
  assert.ok(rules({ evidence: '조회 결과는 같았다 — 변화가 없었다.' }).includes('em-dash'));
  assert.ok(rules({ evidence: '조회는 10:53UTC에 했다.' }).includes('spacing-timezone'));
});

test('noun endings, chained interpuncts, long bodies, long evidence and excess precision are reported', () => {
  assert.ok(rules({ text: '공식 운영 변화 미확인.' }).includes('noun-ending'));
  assert.ok(rules({ evidence: '조회 10:53 UTC. 변화는 없었다.' }).includes('noun-ending'));
  assert.ok(!rules({ text: '그는 “확인했다.”라고 말하지 않았다.' }).includes('noun-ending'));
  assert.ok(rules({ title: 'A·B·C·D 유지' }).includes('title-dots'));
  assert.ok(rules({ text: 'A·B·C·D·E는 같다.' }).includes('sentence-dots'));
  assert.ok(rules({ text: '하나다.\n\n둘이다. 셋이다.\n\n넷이다. 다섯이다.' }).includes('text-length'));
  assert.ok(rules({ evidence: '가'.repeat(251) + '다.' }).includes('evidence-length'));
  assert.ok(rules({ evidence: '하나다.\n\n둘이다. 셋이다.\n\n넷이다.' }).includes('evidence-length'));
  assert.ok(rules({ text: '10:47:58.559 UTC 값이다.' }).includes('precision'));
  assert.ok(rules({ evidence: '조회는 18:16:42에 했다.' }).includes('precision'));
  assert.ok(rules({ text: '시가 대비 +1.4490%다.' }).includes('precision'));
  assert.ok(!rules({ text: '시가 대비 1.45% 올랐다.' }).includes('precision'));
});

test('sentence limits follow the kind, and three sentences need paragraph breaks', () => {
  assert.ok(rules({ kind: '변화 없음', text: 'A는 같다. B도 같다.' }).includes('text-length'));
  assert.ok(!rules({ kind: '변화 없음', text: 'A와 B는 직전 점검과 같다.' }).includes('text-length'));
  assert.ok(rules({ kind: '확인 제한', text: 'A가 열리지 않았다.\n\nB도 열리지 않았다.\n\nC도 열리지 않았다.' }).includes('text-length'));
  assert.ok(rules({ text: '하나다. 둘이다. 셋이다.' }).includes('paragraphs'));
  assert.ok(rules({ evidence: '하나다. 둘이다. 셋이다.' }).includes('paragraphs'));
  assert.ok(!rules({ text: '하나다. 둘이다.\n\n셋이다.' }).includes('paragraphs'));
  assert.ok(!rules({ text: '하나다. 둘이다.' }).includes('paragraphs'));
});

test('a doubly escaped newline is reported because it shows on screen as a backslash and n', () => {
  assert.ok(rules({ text: '첫 단락이다.\\n\\n둘째 단락이다.' }).includes('escaped-newline'));
  assert.ok(!rules({ text: '첫 단락이다.\n\n둘째 단락이다.' }).includes('escaped-newline'));
});

test('only the six writing kinds pass, and the newest run is selected by default', () => {
  assert.ok(rules({ kind: '가격·페그 관찰' }).includes('kind-vocabulary'));
  for (const kind of ['기준점', '감시 설정', undefined]) assert.ok(rules({ kind }).includes('kind-vocabulary'));
  for (const kind of ['새 사실', '정정', '누락 보완', '참고', '확인 제한', '변화 없음'])
    assert.ok(!rules({ kind }).includes('kind-vocabulary'));
  const feed = [{ at: '2026-11-04T10:00:00Z' }, { at: '2026-11-04T11:00:00Z' }, { at: '2026-11-04T11:00:00.000Z' }];
  assert.deepEqual(selectRecords(feed, false), feed.slice(1));
  assert.deepEqual(selectRecords(feed, true), feed);
  assert.deepEqual(selectRecords([], false), []);
});

test('category summaries follow the title rules for headline and the sentence rules elsewhere', () => {
  const warnings = lintSummary({
    headline: '11/4 19:51 보안 점검 — GitHub발 장애 추가',
    body: 'GitBook에 동기화 장애가 추가됐다. 새 침해와는 구분.',
    unknown: '공식 발언·공통 침해 경로·준비금 복구·독립 검증·직접 출금 재개 여부는 아직 알 수 없다.',
    gap: '하원435개 페이지 전수 확인은 하지 못했다.',
  });
  const by = field => warnings.filter(w => w.field === field).map(w => w.rule);
  assert.deepEqual(by('headline'), ['title-time', 'em-dash']);
  assert.deepEqual(by('body'), ['noun-ending']);
  assert.deepEqual(by('unknown'), ['sentence-dots']);
  assert.deepEqual(by('gap'), ['spacing-number']);
  // Summaries are single paragraphs: neither paragraph nor kind rules apply to them.
  assert.ok(warnings.every(w => !['paragraphs', 'kind-vocabulary', 'text-length'].includes(w.rule)));
  assert.deepEqual(lintSummary({ headline: 'GitBook 동기화 장애 추가', body: '장애가 이어지고 있다.', unknown: '', gap: '' }), []);
});
