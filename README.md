# chatgpt-dot-monitoring-hub
chatgpt-dot-monitoring-hub

## 노션 분할 임베드용 보기

노션 임베드 블록에는 최대 높이가 있어서, 상황판 전체를 한 블록에 담으면 프레임 안에서 스크롤해야 합니다. 그래서 주소 뒤에 `?view=` 값을 붙이면 상황판의 한 부분만 보이도록 했습니다. 노션 허브에는 아래 세 주소를 임베드 블록 세 개로 위아래에 쌓아 둡니다.

| 주소 | 보이는 부분 |
|---|---|
| `https://tlzkrh1029.github.io/chatgpt-dot-monitoring-hub/?view=status` | 제목, 스냅숏 안내, 범주별 지금 상황, 감시 강도 |
| `https://tlzkrh1029.github.io/chatgpt-dot-monitoring-hub/?view=feed` | 새 소식 (넓은 화면에서는 두 단) |
| `https://tlzkrh1029.github.io/chatgpt-dot-monitoring-hub/?view=checks` | 다음 확인, 확인하지 못한 자료, 기록 원칙, 감시 단계 기준 |

`?view=` 없이 열면 지금처럼 전체 화면이 보입니다.

`index.html`을 다시 만들거나 데이터를 바꿀 때는 다음 세 가지를 지우지 말아 주세요. 지우면 노션의 분할 임베드가 전체 화면으로 돌아갑니다.

- `<head>` 안의 `Embed views` 스크립트
- `<style>` 끝의 `Embed views` CSS
- `status-sec`, `levels` 클래스 (범주별 지금 상황 영역과 감시 단계 기준 영역에 붙어 있습니다)
