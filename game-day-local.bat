@echo off
chcp 65001 >nul
cd /d "%~dp0"

REM === 내 PC에서 준PO 예매 (기본: 5차전 16:00 / gc=26014425) ===
REM 1차전 14:00 = 26014417 / 2차전 15:00 = 26014419 / 5차전 16:00 = 26014425

set LOCAL=1
set CHANNEL=chrome
set HEADLESS=0
set SEAT_COUNT=3
set OPEN_EARLY_MS=5000
set PREP_AT=15:00
set TARGET_OPEN=16:00
set GOODS_CODE=26014425

echo.
echo [NOL 기아홈] LOCAL Chrome / goods=%GOODS_CODE% / open=%TARGET_OPEN%
echo 다른 기기·클라우드 예매창은 모두 닫으세요.
echo.

if not exist node_modules (
  echo npm install...
  call npm install
  call npx playwright install chromium
)

call npm run game-day:local
pause
