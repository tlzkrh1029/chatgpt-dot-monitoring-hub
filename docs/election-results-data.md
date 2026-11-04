# 선거 결과 탭 게시 계약 v1

`election-results.html`은 `data/election-results.json` 한 파일만 읽어 상원·하원 의석, 주별 결과 지도, 남은 접전을 그립니다. 이 계약은 기존 다섯 범주 계약(`public-data.js`)과 병렬 탭 계약(`parallel-core.js`)을 바꾸지 않는 독립 계약입니다. 검증 코드는 `election-results-data.js`에 있고, 브라우저와 `npm run validate`가 같은 코드를 씁니다.

## 작성 주체와 주기

- 작성 주체는 미국 중간선거 감시 작업입니다. `data/election.json`을 갱신하는 같은 회차에 이 파일도 갱신합니다.
- 화면은 60초마다 파일을 다시 읽습니다. 화면은 파일을 쓰지 않습니다.
- 판정 확인 시각(`observedAt`)이 90분 넘게 지나면 화면이 지연을 표시합니다.

## 판정 원칙

- `provider`는 기준 제공자입니다(현재 DDHQ). 경합의 판정은 기준 제공자의 당선 판단을 우선합니다.
- 기준 제공자의 판단을 확인하지 못했고 다른 언론의 당선 판단만 확인했다면, `status: "called"`로 두고 `calledBy`에 그 언론을 적습니다(AP, CBS, NBC, ABC 등). 판정 주체를 밝히지 않은 보도는 `calledBy: "언론 보도"`로 적고 `note`에 한계를 남깁니다.
- 기준 제공자가 미판정인데 다른 언론이 판정했다면 `status: "uncalled"`를 유지하고 다른 판단은 `otherCalls`에 넣습니다. 두 판단을 합치지 않습니다.
- 앞선 후보는 승자가 아닙니다. 미판정 경합은 `leader`와 `candidates`로만 표시합니다. 동률이면 `leader: "tie"`입니다.
- 개별 판정을 확인하지 못한 경합은 `status: "unknown"`으로 둡니다. 합계만 보고 개별 판정을 추정해 채우지 않습니다.
- 판정은 언론 판단이며 공식 인증과 다릅니다. 인증·재검표·결선은 `note`와 `status: "runoff"`로 구분합니다.

## 최상위 필드

모든 필드가 필수이고, 등록되지 않은 필드는 거부합니다. 시간은 기존 계약과 같은 UTC ISO 8601 형식입니다.

| 필드 | 형식·의미 |
|---|---|
| schemaVersion | 숫자 1 |
| kind | `"election-results"` |
| provider | 기준 제공자 이름, 40자 이내 |
| publishedAt | 이 JSON 작성 시각 |
| observedAt | 기준 제공자 원문을 실제로 마지막 점검한 시각. publishedAt보다 늦을 수 없음 |
| checkStatus | ok, partial, error. partial·error이면 note가 비어 있으면 안 됨 |
| note | 화면 상단 안내문, 1,000자 이내 일반 텍스트 |
| chambers | 아래 의회·주지사 합계 |
| races | `senate`(35개 주)와 `governor`(36개 주). 키는 주 약칭이며 누락·추가 모두 거부 |
| sources | 공개 HTTPS URL 0–24개. 기존 계약과 같은 URL 제한 적용 |

## chambers

| 위치 | 필드 |
|---|---|
| senate | `seats` 100, `majority` 51, `tieBreaker`(부통령 소속, D·R·null), `notUp`(이번에 선거가 없는 의석 D·R·I·O), `independentsCaucus`(무소속이 함께하는 정당, D·R·null), `control`(다수당 판단 또는 null) |
| house | `seats` 435, `majority` 218, `totals`(D·R·I·O·uncalled, 합계가 435), `flips`(정당이 바뀐 의석 D·R 또는 null), `control` |
| governor | `states` 50, `notUp`(D·R·I·O), `totals`(기준 제공자의 현직 포함 합계 D·R·I·O·uncalled, 합계가 50, 또는 null) |

`control`은 `{ "party": "D", "by": "DDHQ", "at": 시각 또는 null }`입니다. 상원 `notUp` 합계와 35개 경합의 합은 100이어야 하고, 주지사 `notUp` 합계와 36개 경합의 합은 50이어야 합니다.

## 경합 한 곳

| 필드 | 형식·의미 |
|---|---|
| status | called, uncalled, runoff, unknown |
| special | 보궐 선거면 true |
| winner | called일 때만 `{ "name", "party" }`, 그 외에는 null |
| calledBy | called일 때 판정한 언론, 그 외에는 null |
| calledAt | 판정 시각 또는 null. called가 아니면 null |
| leader | uncalled·runoff에서 D·R·I·O·tie 또는 null. called·unknown이면 null |
| candidates | 0–4명, `{ "name", "party", "votes", "pct" }`. votes는 정수 또는 null, pct는 0–100 또는 null |
| reported | 기준 제공자의 예상 투표수 대비 집계율 0–100 또는 null |
| otherCalls | 0–3개, `{ "by", "party", "name" }`. 기준 제공자와 다른 언론의 판단 |
| note | 300자 이내 일반 텍스트. 링크는 sources에만 넣음 |

정당 코드는 D(민주), R(공화), I(무소속), O(기타)입니다. 이름과 문장에는 링크·연락처·자격 증명을 넣지 않습니다.

## 갱신 절차

1. 최신 SHA와 함께 `data/election-results.json`을 읽습니다.
2. 기준 제공자의 상원·하원·주지사 합계 페이지와 71개 개별 경합 페이지를 점검합니다. 실제로 점검한 경우에만 observedAt을 진행시킵니다.
3. 새로 확인한 판정·집계만 고칩니다. 확인하지 못한 경합은 이전 값을 유지하고 checkStatus를 partial로 둡니다. 전체 점검이 실패하면 이전 자료를 유지하고 checkStatus를 error로, 실패 사유를 note에 적습니다.
4. publishedAt을 기록하고 `npm test`와 `npm run validate`를 통과시킵니다.
5. 이 파일만 현재 SHA를 조건으로 커밋합니다. 충돌하면 다시 읽고 다시 합칩니다. 다른 파일은 바꾸지 않습니다.

## 노션 분할 임베드

`?view=power`(다수당 판세), `?view=map`(주별 결과), `?view=close`(남은 접전)는 한 영역만 보여 줍니다. 주소에 보기를 붙이지 않으면 전체 화면입니다.
