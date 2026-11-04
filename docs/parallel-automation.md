# 병렬 시세 수집과 공개 반영

자동 수집 대상은 BTC·ETH·HYPE·ZEC·XMR의 Coin Metrics Community `ReferenceRateUSD` 1분 자료다. 여러 시장을 합성한 USD 기준가격이며 특정 거래소 체결가나 OHLC가 아니다. 주식·지수·환율·금의 나머지 14계열은 공개 이용 가능한 공급자가 연결될 때까지 미지원으로 둔다.

## 이용 범위와 출처

이 개인용 상황판의 자동 수집은 비상업적 이용을 전제로 한다. 수집 명령에는 `COIN_METRICS_USAGE=noncommercial`을 명시한다. 상업적 서비스에 재사용하려면 먼저 해당 용도에 맞는 이용 권한과 공급원을 확보해야 한다. 이 환경변수나 스키마 검증 자체가 이용 권한을 부여하지는 않는다.

- [Community 제공 범위·요청 제한](https://gitbook-docs.coinmetrics.io/packages/coin-metrics-community-data)
- [기준가격 계산과 시간 의미](https://gitbook-docs.coinmetrics.io/coin-metrics-prices/coin-metrics-prices/reference-rate-metrics)
- [CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/)

화면과 게시 JSON에 Coin Metrics 출처, 라이선스 링크, 1분 원자료를 15분 표본 및 08:00 KST 대비 등락률로 변환했다는 설명을 보존한다. Coin Metrics의 보증이나 특정 거래소 시세로 표현하지 않는다.

## 수집·변환

`scripts/update-parallel-prices.js`는 API 키 없이 Community 원자료를 조회한다. 시작·끝 시각을 명시하고 페이지를 끝까지 읽으며, 후속 URL은 동일 HTTPS 호스트와 시계열 경로만 허용한다. 페이지·응답 크기·시간을 제한한다.

가장 최근 08:00 KST를 세션 시작으로 삼는다. 정확한 기준 시각의 양수 가격이 있어야 등락률을 계산한다. 정확한 15분 시각만 선택하며 누락을 보간하거나 인접 값을 기준값으로 대체하지 않는다. 원가격 문자열·기준값·마지막 1분 자료·15분 표본·요청 범위·수신 시각을 `schemaVersion: 2`의 공급자 기록에 보존한다.

새 거래일·기준값에는 새 계열 ID를 사용한다. 동일 ID에 이미 게시한 관측을 변경하거나 삭제하는 자료는 수신기가 거부한다. 원자료 수정이 발생하면 조용히 과거를 덮어쓰지 않고 실패를 드러낸다. API 장애·기준값 부재·검증 실패는 정상 게시 자료의 원자료 시각을 진전시키지 않는다.

Community의 세밀한 과거 제공 범위는 제한된다. 현재 응답에서 긴 이력이 보이더라도 장기 제공을 보장하지 않는다. 처음 연결하거나 세션이 바뀔 때 정확한 08:00 기준값을 받을 수 없다면 성공으로 처리하지 않는다.

## 자동 실행과 배포

`.github/workflows/update-parallel-prices.yml`은 매시 03·13·23·33·43·53분에 실행하며, Actions의 **Update parallel market prices → Run workflow → main**으로 수동 실행할 수도 있다. GitHub 예약 실행은 지연되거나 누락될 수 있으므로 정확한 10분 주기를 보장하지 않는다.

실행은 다음 순서다.

1. 최신 main 체크아웃 → 시세 수집 → 전체 테스트와 게시 계약 검증.
2. `data/parallel.json`만 커밋. 다른 작성자가 갱신한 main을 가져와 리베이스하고 재검증 후 일반 push. 강제 push는 사용하지 않는다.
3. 기존 branch-based Pages에 빌드를 명시적으로 요청한다. `GITHUB_TOKEN` push만으로는 기존 Pages 빌드가 시작되지 않는다.
4. 빌드 결과와 공개 `data/parallel.json`의 SHA-256을 확인한다. 커밋 성공이나 빌드 요청 접수만으로 공개 반영을 성공 처리하지 않는다.

workflow 권한은 이 경로에 필요한 `contents: write`, `pages: write`다. 새 PAT·API 키·계정이나 Pages 설정 변경은 필요하지 않다. 기존 Pages 설정이 `main`의 루트에서 게시하는 방식과 다르면 자동 변경하지 않고 명시적으로 실패한다.

수집 workflow는 동시에 하나만 실행한다. GitHub Pages branch build는 시간당 10회 soft limit이 있으므로 기존 감시 작업의 빌드와 합산해 관찰한다. 이미 동일 JSON이 공개됐으면 중복 빌드를 요청하지 않는다.

## 화면에서 확인할 시각

- 원자료 최신 시각: 공급자가 계산한 마지막 1분 기준가격의 시각.
- 마지막 차트 표본: 그래프에 그린 마지막 15분 표본의 시각.
- 원자료 확인 시각: 수집기가 실제 응답을 받은 시각.
- 파일 작성 시각: 검증된 게시 JSON을 작성한 시각.
- 게시자료 수신 시각: 브라우저가 공개 JSON을 받은 시각.

브라우저의 5·10·15분 선택은 마지막 단계의 재수신 간격이다. 원자료가 20분 이상 뒤처지면 최신 수신 시각으로 덮어 보이지 않고 오래된 자료 상태를 표시한다.

## 실패 확인

Actions의 실패 단계와 로그를 먼저 본다. 수집·검증 실패면 마지막 정상 데이터가 남는다. push는 성공했지만 Pages 확인이 실패했다면 Git의 JSON과 공개 사이트가 다를 수 있으므로, **Run workflow**로 다시 실행해 수집·검증·게시를 재확인한다. 공개 확인 요청에는 GitHub 인증 토큰을 보내지 않는다.

참고: [GITHUB_TOKEN 트리거 제한](https://docs.github.com/en/actions/concepts/security/github_token), [Pages 빌드 요청 API](https://docs.github.com/en/rest/pages/pages#request-a-github-pages-build), [예약 실행](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule), [Pages 제한](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits).
