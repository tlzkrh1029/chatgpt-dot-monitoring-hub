'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const T = require('../feed-text.js');
const M = require('../public-data.js');

const read = file => JSON.parse(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'));
const now = () => Math.max(Date.parse('2026-11-04T10:00:00Z'), Date.now());
const publishedTexts = () => {
  const data = M.composeData(M.validateData(read('data.json'), { now: now() }), Object.keys(M.CATEGORY_CONFIG)
    .map(key => M.validateCategory(read(`data/${key}.json`), key, { now: now() })));
  return data.feed.flatMap(row => [row.text, row.evidence]).filter(Boolean);
};
const norm = s => s.replace(/\s+/g, ' ').trim();

test('writer line breaks win: blank lines, a newline after a sentence end, and list items', () => {
  assert.deepEqual(T.paragraphs('A는 첫 단락이다.\n\nB는 둘째 단락이다. C도 같은 단락이다. D도 같은 단락이다.'),
    ['A는 첫 단락이다.', 'B는 둘째 단락이다. C도 같은 단락이다. D도 같은 단락이다.']);
  assert.deepEqual(T.paragraphs('A는 첫 줄이다.\nB는 둘째 줄이다.'), ['A는 첫 줄이다.', 'B는 둘째 줄이다.']);
  assert.deepEqual(T.paragraphs('기준:\n- 첫 항목이다\n- 둘째 항목이다'), ['기준:', '- 첫 항목이다', '- 둘째 항목이다']);
  // A newline inside a sentence is a soft wrap, and CRLF or a stray edge newline changes nothing.
  assert.deepEqual(T.paragraphs('한 문장이 줄바꿈으로\n이어진다.'), ['한 문장이 줄바꿈으로 이어진다.']);
  assert.deepEqual(T.paragraphs('A다.\r\n\r\nB다.'), ['A다.', 'B다.']);
  for (const empty of ['', ' \n\n ', undefined, null]) assert.deepEqual(T.paragraphs(empty), []);
});

test('short texts stay one paragraph and no paragraph is a fragment', () => {
  assert.deepEqual(T.paragraphs('한 문장뿐이다.'), ['한 문장뿐이다.']);
  const short = '공식 운영 변화는 없었다. VIX 지연값은 하락했다. 페그 이탈은 기준에 못 미쳤다.';
  assert.deepEqual(T.paragraphs(short), [short]);
  for (const value of publishedTexts()) {
    const parts = T.paragraphs(value);
    if (parts.length > 1) for (const part of parts) assert.ok(T.width(part) >= 40, part);
  }
});

test('every published text and evidence note survives splitting unchanged, and splitting is idempotent', () => {
  for (const value of publishedTexts()) {
    const parts = T.paragraphs(value);
    assert.ok(parts.length >= 1 && parts.every(part => part.trim()));
    assert.equal(norm(parts.join(' ')), norm(value));
    assert.deepEqual(T.paragraphs(parts.join('\n\n')), parts);
  }
});

test('back-references stay with their antecedent and topic seams open paragraphs', () => {
  // "한국시간은 각각" restates the list before it; "앞선 세 건은" names what it refers to.
  const calls = 'DDHQ 판정은 조지아 키샤 랜스 보텀스 11월 3일 21:13 EST, 아이오와 롭 샌드 21:57 EST, 오하이오 에이미 액턴 22:30 EST, 텍사스 지나 이노호사 11월 4일 00:00 EST다. 한국시간은 각각 11월 4일 11:13·11:57·12:30·14:00, UTC는 02:13·02:57·03:30·05:00이다. 앞선 세 건은 이전 공개 요약에 누락된 판정을 보완한 것이고, 텍사스는 플로리다 보완 확인 이후 나온 판정이다.';
  const callParts = T.paragraphs(calls);
  assert.equal(callParts.length, 2);
  assert.ok(callParts[0].includes('한국시간은 각각'));
  assert.ok(callParts[1].startsWith('앞선 세 건은'));
  // Market figures and operations notices are different sources; "둘 다" stays with its pair.
  const macro = 'Cboe VIX는 18.19(-12.67%), MarketWatch는 10:17 UTC의 18.24(-12.43%)다. 둘 다 전일 20.83 대비이며 지연·시각 차이가 남는다. DXY는 10:24 UTC의 101.32(-0.54%, 전일 101.87 대비)다. FRED의 11월 2일 OAS 343bp·SOFR 3.95%·10년물 4.91%는 동일하다. Coinbase Sonic·Circle Cronos 장애와 기존 완료 공지도 같다. GitHub Git 작업·이슈·풀리퀘스트·Actions 장애는 보안 감시에 이미 기록된 사건이며 새 침해로 분류하지 않는다.';
  const macroParts = T.paragraphs(macro);
  assert.equal(macroParts.length, 2);
  assert.ok(macroParts[0].includes('둘 다 전일'));
  assert.ok(macroParts[1].startsWith('Coinbase Sonic'));
  // "…도 관측값이 같다" continues the unchanged figures; the new cross-check opens a paragraph.
  const election = '상원35·주지사36 경선 개별 페이지를 재점검했으며 Oregon 주지사만 접근 실패했다. DDHQ 하원241D·149R, 상원54D·44R, 주지사27D·20R 및 열람 가능한 경선의 당선 판단은 직전과 같다. Alaska 상원 선두1,796표, Mississippi 상원2,169표, Kansas 주지사5,557표와 CO03 하원 Hurd선두1,211표도 관측값이 같다. Kansas 공식 비공식 결과에서 Holscher546,587표·Masterson541,030표, 합계1,087,617표를 직접 확인해 DDHQ와 일치함을 확인했다. 보고 투표구4168/4168은 모든 유효표 최종 처리·인증 완료를 뜻하지 않는다.';
  const electionParts = T.paragraphs(election);
  assert.equal(electionParts.length, 2);
  assert.ok(electionParts[0].endsWith('관측값이 같다.'));
  assert.ok(electionParts[1].startsWith('Kansas 공식 비공식 결과에서'));
});

test('sentence boundaries skip abbreviations, initials, decimals and times', () => {
  assert.deepEqual(T.sentences('U.S. 하원 결과가 나왔다. Mr. Kim은 J. Smith와 만났다. 0.9985와 10:47:58.559 UTC는 한 문장이다!'),
    ['U.S. 하원 결과가 나왔다.', 'Mr. Kim은 J. Smith와 만났다.', '0.9985와 10:47:58.559 UTC는 한 문장이다!']);
  assert.deepEqual(T.sentences('첫 단락이다.\n\n둘째 단락이다. 셋째 문장이다'), ['첫 단락이다.', '둘째 단락이다.', '셋째 문장이다']);
  assert.deepEqual(T.sentences(''), []);
  // "EST." ends a sentence even though "est." could be an abbreviation in English prose.
  assert.equal(T.sentences('판정은 21:13 EST. 집계는 계속됐다.').length, 2);
});

test('quotations and brackets never end a sentence or a paragraph inside them', () => {
  const quoted = 'Binance는 공지에서 “일부 사용자의 출금이 네트워크 혼잡으로 약 40분 동안 지연됐으며 현재는 모든 출금이 정상적으로 처리되고 있다. 사용자 자금은 모두 안전하게 보관되어 있으며 이번 지연은 보안 사고와 관계가 없다.”라고 밝혔다. Binance 상태 페이지에는 같은 시각 출금 지연 표시가 남아 있었다.';
  for (const part of T.paragraphs(quoted)) assert.equal((part.match(/“/g) || []).length, (part.match(/”/g) || []).length, part);
  assert.equal(T.sentences('Binance 공지는 “출금이 지연됐다. 사용자 자금은 안전하다.”라는 문구까지 직전 기록과 같다.').length, 1);
  assert.equal(T.sentences('ZachXBT는 "피해 기관은 A다. 피해액은 B다."라고 주장했다. 은행은 확인하지 않았다.').length, 2);
  assert.equal(T.sentences("공지는 '출금이 지연됐다. 자금은 안전하다.'라는 문구가 같다.").length, 1);
  // Apostrophes are not quotation marks.
  assert.equal(T.sentences("Binance's 공지는 같다. GitBook’s 공지도 같다.").length, 2);
  assert.deepEqual(T.sentences('미국(U.S.) 국채 10년물 금리는 4.12%로 올랐다. VIX는 18.2로 내렸다.'),
    ['미국(U.S.) 국채 10년물 금리는 4.12%로 올랐다.', 'VIX는 18.2로 내렸다.']);
  assert.equal(T.sentences('갱신 표시(Nov. 4, 2026, 12:58 a.m.)는 시간대가 없어 변환하지 않았다. 둘째 문장이다.').length, 2);
});

test('dotted dates and case names are not sentence ends', () => {
  assert.deepEqual(T.sentences('업비트 공지의 게시 표시는 2026. 11. 4. 오전 4:42이며 시간대 표시가 없다. 다음 문장이다.'),
    ['업비트 공지의 게시 표시는 2026. 11. 4. 오전 4:42이며 시간대 표시가 없다.', '다음 문장이다.']);
  assert.equal(T.sentences('기준 연도는 2026. 다음 문장이다.').length, 2);
  assert.deepEqual(T.sentences('원고 측은 Purcell v. Gonzalez 판결을 근거로 들었다. 주정부는 반박했다.'),
    ['원고 측은 Purcell v. Gonzalez 판결을 근거로 들었다.', '주정부는 반박했다.']);
});

test('a single soft-wrapped block is split like the same text without the newline', () => {
  const soft = 'Kansas 주정부의 비공식 집계에서 Holscher 후보는 546,587표, Masterson 후보는 541,030표를 얻었다. DDHQ의 Kansas 집계는 18:57에 갱신된 값이며 두 후보의 격차 5,557표는 직전 기록과 같다. Kansas의 투표구 4,168곳이 모두 보고됐지만\n공식 인증까지 끝났다는 뜻은 아니다.';
  const parts = T.paragraphs(soft);
  assert.deepEqual(parts, T.paragraphs(soft.replace('\n', ' ')));
  assert.deepEqual(T.paragraphs(parts.join('\n\n')), parts);
});

test('long runs of punctuation, quotes or particles stay fast', () => {
  const inputs = ['앞 문장이다. ' + '-'.repeat(7980) + 'x 다.', '가' + '.'.repeat(7999), '"'.repeat(8000),
    '앞이다.' + '”'.repeat(7990) + ' 뒤다.', '가도 '.repeat(2600) + '같다.'];
  const started = Date.now();
  for (const input of inputs) { T.paragraphs(input); T.sentences(input); }
  assert.ok(Date.now() - started < 1000, `took ${Date.now() - started}ms`);
});
