# 병렬 타임라인 자료 계약 v1

이 계약은 기존 다섯 JSON 작성 계약과 독립적이다. 작성 작업은 자기 파일 `data/parallel.json`만 현재 원격 SHA를 조건으로 수정한다. 원문 점검·공급자 이용 조건 확인·실제 수집 서비스 연결은 아직 구성되지 않았다.

## 공개 데이터와 로컬 참조

- 공개 파일은 `mode: observed`를 사용한다. 실제 숫자가 있는 계열에는 `verification: verified`, `redistribution: permitted`, 공개 원출처 URL, 원자료·관찰·게시 시각이 모두 필요하다. 이 표시는 작성자의 실제 증거 확인을 전제로 하며 스키마 검증만으로 이용 권한이 입증되지는 않는다.
- `mode: reference`의 숫자와 사건은 명시적인 로컬 참조 로드에서만 허용된다. 공개 fetch 컨트롤러는 이를 거부한다. CSV 파서는 검증·재배포 권한을 승격하지 않는다.
- 현재 공개 파일은 19개 미지원 계열의 빈 `points`와 원출처 확인된 DDHQ 사건 세 건만 포함한다. 새 공급자 구독·API 키·외부 수집·예약 작업·권한 변경을 추가하지 않았다. Coinbase 시세를 사용하지 않는다.
- 실제 외부 시계열 공급을 연결하기 전에는 원자료 API 기능·시각 의미·거래 세션·지연·공개 재배포 조건을 검증해야 한다. CFD를 선물로, TradingView 대체지수를 ICE 지수로 표시하면 안 된다. 위젯 표시 허용이 원시 시계열 추출·재배포 허용을 뜻하지 않는다.

## 문서 구조

모든 필드는 필수이며 미등록 필드는 거부한다. 시각은 UTC ISO 문자열이고 화면은 KST로 변환한다.

| 위치 | 필드 |
|---|---|
| 최상위 | `schemaVersion: 1`, `mode`, `title`, `publishedAt`, `window`, `series`, `events`, `stories` |
| window | `start`, `end`, `timezone: Asia/Seoul`, `intervalMinutes: 15` |
| series 항목 | `id`, `panel`, `label`, `instrument`, `basis`, `provider`, `sourceUrl`, `verification`, `redistribution`, `availability`, `asOf`, `observedAt`, `delaySeconds`, `marketState`, `points` |
| points 항목 | `at`, `pct` |
| events 항목 | `id`, `at`, `label`, `type`, `verification`, `sourceUrl`, `observedAt` |
| stories 항목 | `at`, `title`, `story`, `sources`, `interpretation`, `verdict`, `nextWatch` |

`panel`은 `indices / ai / crypto / fx`다. `availability`는 `unsupported / delayed / available`, `marketState`는 `unknown / open / closed`다. 공급자와 상품 식별자·통화·비교 기준 거래일/시각은 `instrument`·`basis`에 명시한다. 숫자는 같은 상품·같은 비교 기준 안에서만 이어야 한다.

`asOf`는 마지막 실제 자료점의 시각이며 최종 `points.at`과 같아야 한다. `observedAt`은 실제 원문 확인 시각, `publishedAt`은 JSON 작성 시각이다. `asOf <= observedAt <= publishedAt`이어야 한다. 공급되지 않은 값의 시각은 `null`, 점은 빈 배열로 둔다. 시세 없는 재수신으로 원자료 시각을 진행시키면 안 된다. 로컬 참조의 `asOf`는 CSV의 마지막 표기 시각일 뿐이며 UI는 실제 원자료 시각 미확인으로 표시한다.

사건 `type`은 `prediction / media_call / official_certification / statement / concession`이다. `at`은 실제 사건 시각이며 관찰 시각으로 대체하면 안 된다. `verified` 사건에는 공개 원출처·관찰·게시 시각이 필요하다. 실제 원출처 확인은 사람이 수행해야 한다. 검증된 사건만 공통 시간축 위 수직선으로 표시한다. 언론 판단을 공식 인증으로 승격하지 않는다.

## 누락·실패·보존

점은 창 안에서 오름차순·중복 없는 실제 시각과 유한 등락률만 허용한다. 15분 초과 간격은 별도 선 조각으로 나누며, 빈 CSV 값은 0으로 채우지 않는다. 내부 누락 격자는 첫 관측과 마지막 관측 사이에서만 센다. 창 가장자리에 자료가 없다는 사실로 휴장이나 거래 중단을 추정하지 않는다.

갱신기는 자기 파일 하나만 읽고, 요청 중복·15초 초과·2MiB 초과·잘못된 JSON·스키마 오류를 막는다. 실패 시 마지막 정상 게시 자료를 유지하고 수신 오류를 표시한다. 게시·원자료·확인 시각의 역행은 거부한다. 겹치는 시간창의 기존 점과 사건을 삭제하거나 바꾸면 거부한다. 원상품·비교 기준·출처가 달라지거나 정정 기록이 필요하면 새 ID를 사용한다. 이동창 밖의 과거 점·사건 생략은 허용한다. 전체 장기 이력은 별도 보관 및 Git 이력 정책이 필요하다.

브라우저가 닫힌 동안 자동 수집하는 기능은 없다. 5/10/15분 선택은 공개 JSON 폴링이며 그보다 오래된 원자료도 그대로 오래된 시각으로 표시한다. 원격 게시와 Pages 반영·배포 확인은 별도 절차다.

## 검증과 안전한 반영

~~~sh
npm test
npm run validate
~~~

코드 반영 직전 최신 main을 가져와 새 커밋 위에 통합한다. 기존 `data.json`과 `data/{macro,election,security,xr,onchain}.json`을 이전 복제본으로 재게시하지 않는다. 로컬 참조 생성물은 Git 제외 여부를 확인하고 명시한 파일만 스테이징한다. 강제 push를 사용하지 않는다.
