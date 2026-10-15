# NOL 티켓 · 기아 홈 가을야구 예매 도우미

예매처는 **NOL(야놀자) 티켓**입니다.  
[포스트시즌 페이지](https://nol.yanolja.com/ticket/genre/sports/postseason)에서  
**기아 홈(광주 챔피언스필드)** 오픈 시 **3연석**을 잡고 **결제 직전**까지 갑니다.

- 로그인 / 본인인증 / **결제**: 직접 (NOL 계정)
- 자동: 타이머 홀드 → 오픈 5초 전 연타(첫 API면 중단) → 대기열 → 좌석 → 결제 직전 정지

> **중요:** 클라우드/원격보다 **내 PC(한국 회선)** 에서 돌리는 게 대기열 순번에 유리합니다.  
> 같은 계정으로 PC·폰·클라우드를 **동시에** 열지 마세요.

## 내 PC에서 실행 (권장)

### 1) 준비 (최초 1회)

```bash
git pull
npm install
npx playwright install chrome
```

Windows면 [Node.js 20+](https://nodejs.org/) 설치 후, 프로젝트 폴더에서 위 명령을 실행하세요.  
시스템에 **Google Chrome** 이 설치되어 있어야 합니다.

### 2) 로그인 (최초 1회)

```bash
npm run login
```

열린 Chrome에서 NOL 로그인·본인인증 후, 터미널에서 **Enter**.  
세션은 `.browser-profile/` 에 저장됩니다.

### 3) 경기일 오픈 노리기

**Windows (더블클릭 또는 cmd):**

```bat
game-day-local.bat
```

기본값은 **준PO 5차전 / 16:00 오픈 / goods=26014425** 입니다.  
다른 경기를 노리려면 `game-day-local.bat` 안의 `GOODS_CODE` / `TARGET_OPEN` 을 바꾸거나:

```powershell
.\game-day-local.ps1 -GoodsCode 26014419 -TargetOpen 15:00 -PrepAt 14:00
```

**Mac/Linux:**

```bash
LOCAL=1 CHANNEL=chrome GOODS_CODE=26014425 TARGET_OPEN=16:00 PREP_AT=15:00 OPEN_EARLY_MS=5000 SEAT_COUNT=3 npm run game-day:local
```

| 경기 | goodsCode | 예매 오픈(당일) |
| --- | --- | --- |
| 준PO 1차전 | `26014417` | 14:00 |
| 준PO 2차전 | `26014419` | 15:00 |
| 준PO 5차전 | `26014425` | 16:00 |

### 동작

1. NOL에서 해당 경기 **예매하기** 1회 → 타이머/게이트 화면 유지  
2. **서버시각 기준 오픈 5초 전**부터 예매 버튼 연타  
3. **첫 예매 API / 대기열 진입 시 즉시 중단** (추가 클릭 없음)  
4. 대기열 통과 → 좌석(중앙테이블≈3루테이블 → 테이블3연석 → 아무3연석) → **결제 직전 정지**  
5. 결제는 직접

## 이미 켜 둔 Chrome에 붙이기 (선택)

로그인된 Chrome을 그대로 쓰려면:

```bat
REM Chrome을 디버그 포트로 실행 (별도 프로필 권장)
chrome.exe --remote-debugging-port=9222 --user-data-dir="%LOCALAPPDATA%\nol-ticket-profile"
```

```bash
CDP_URL=http://127.0.0.1:9222 GOODS_CODE=26014425 TARGET_OPEN=16:00 npm run game-day
```

## 좌석 우선순위

1. 중앙테이블 ≈ 3루 테이블  
2. 그 외 테이블 3연석  
3. 아무 3연석  

`config.json` 의 `preferredGrades` / `avoidGrades` 로 조정.

## 보안문자

OCR 최대 2회 시도 후 실패 시 수동 입력 대기.

## 주의

- NOL 이용약관상 매크로·비정상 예매는 취소될 수 있습니다. **본인 직관용** 전제입니다.
- 카드 정보는 입력하지 않습니다.
- 클라우드 에이전트와 **동시에** 돌리지 마세요 (같은 계정 충돌·비정상접근).
