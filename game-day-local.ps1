# 내 PC에서 준PO 예매 (PowerShell)
# 사용: .\game-day-local.ps1
# 또는: .\game-day-local.ps1 -GoodsCode 26014419 -TargetOpen 15:00

param(
  [string]$GoodsCode = "26014425",
  [string]$TargetOpen = "16:00",
  [string]$PrepAt = "15:00",
  [int]$SeatCount = 3,
  [int]$OpenEarlyMs = 5000
)

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

$env:LOCAL = "1"
$env:CHANNEL = "chrome"
$env:HEADLESS = "0"
$env:SEAT_COUNT = "$SeatCount"
$env:OPEN_EARLY_MS = "$OpenEarlyMs"
$env:PREP_AT = $PrepAt
$env:TARGET_OPEN = $TargetOpen
$env:GOODS_CODE = $GoodsCode

Write-Host ""
Write-Host "[NOL 기아홈] LOCAL Chrome / goods=$GoodsCode / open=$TargetOpen"
Write-Host "다른 기기·클라우드 예매창은 모두 닫으세요."
Write-Host ""

if (-not (Test-Path "node_modules")) {
  npm install
  npx playwright install chromium
}

npm run game-day:local
