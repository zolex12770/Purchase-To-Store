# Deploys ONLY the Purchase-to-Store frontend build (served by pm2 app "zolex-purchase-frontend", vite preview on 8080).
# The preview server reads files from disk per request, so the build folder is swapped without stopping it.
#
#   1. Build: cd frontend; npx tsc -b; npx vite build --outDir dist-next
#   2. Run:   powershell -NoProfile -ExecutionPolicy Bypass -File deploy\windows\deploy-frontend.ps1
#
# The previous build is kept as frontend\dist-prev-<stamp>; its hashed asset files are also copied into the new
# build so that browser tabs opened before the swap keep working until they are refreshed.
# Roll back:  rename frontend\dist to dist-rolledback-<stamp> and frontend\dist-prev-<stamp> back to dist.
# Keep this file pure ASCII (Windows PowerShell 5.1).
$ErrorActionPreference = 'Stop'
$here     = Split-Path -Parent $MyInvocation.MyCommand.Path
$repo     = (Resolve-Path (Join-Path $here '..\..')).Path
$frontend = Join-Path $repo 'frontend'
$app      = 'zolex-purchase-frontend'
$stamp    = Get-Date -Format 'yyyyMMdd-HHmmss'
$prev     = "dist-prev-$stamp"

if (-not (Test-Path "$frontend\dist-next\index.html")) { throw 'frontend\dist-next is not built.' }
$c = Get-NetTCPConnection -LocalPort 8080 -State Listen | Select-Object -First 1
$owner = Get-CimInstance Win32_Process -Filter "ProcessId=$($c.OwningProcess)"
if ($owner.CommandLine -notmatch 'preview --port 8080') { throw "Port 8080 is not the vite preview: $($owner.CommandLine)" }
$newEntry = (Select-String -Path "$frontend\dist-next\index.html" -Pattern 'assets/index-[A-Za-z0-9_-]+\.js').Matches[0].Value
$oldEntry = (Select-String -Path "$frontend\dist\index.html" -Pattern 'assets/index-[A-Za-z0-9_-]+\.js').Matches[0].Value
"precheck ok: 8080 = PID $($c.OwningProcess); old entry $oldEntry -> new entry $newEntry"

Rename-Item "$frontend\dist" $prev
Rename-Item "$frontend\dist-next" 'dist'
$kept = 0
Get-ChildItem "$frontend\$prev\assets" -File | ForEach-Object {
  if (-not (Test-Path "$frontend\dist\assets\$($_.Name)")) { Copy-Item $_.FullName "$frontend\dist\assets\$($_.Name)"; $kept++ }
}
"swapped: previous build kept at frontend\$prev ($kept old asset files left reachable for open tabs)"

Start-Sleep -Milliseconds 800
$html = (Invoke-WebRequest -UseBasicParsing -TimeoutSec 10 'http://localhost:8080/').Content
$servedNew = $html -match [regex]::Escape($newEntry)
"8080 serves the new build: $servedNew"
if (-not $servedNew) {
  "the preview still serves the old page - restarting ONLY $app"
  pm2 restart $app | Out-Null
  Start-Sleep -Seconds 4
  $html = (Invoke-WebRequest -UseBasicParsing -TimeoutSec 10 'http://localhost:8080/').Content
  "after restart, 8080 serves the new build: $($html -match [regex]::Escape($newEntry))"
}
$js = Invoke-WebRequest -UseBasicParsing -TimeoutSec 10 "http://localhost:8080/$newEntry"
"new entry script: HTTP $($js.StatusCode), $($js.Content.Length) bytes"
"api through 8080: " + (Invoke-WebRequest -UseBasicParsing -TimeoutSec 10 'http://localhost:8080/api/v1/health').Content
Set-Content (Join-Path $here 'deploy-frontend-last.json') (@{ prev = $prev; stamp = $stamp } | ConvertTo-Json) -Encoding ascii
