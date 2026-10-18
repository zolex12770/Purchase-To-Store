# Starts / stops an ISOLATED staging copy of the Purchase-to-Store application (API 4012, UI 8092) on a scratch
# database, with no Google access, for rehearsing a release before it goes to production.
#   1. Restore a backup into a scratch root (the live database is never opened):
#        cd backend; npx tsx src\db\cli-verify-restore.ts <backup file> --keep      (prints the kept folder)
#   2. Build into backend\dist-staging and frontend\dist-staging (as for a deploy, with --outDir dist-staging).
#   3. .\deploy\windows\staging-instance.ps1 start -Root <kept folder>
#      .\deploy\windows\staging-instance.ps1 stop
# Never touches ports 4001/8080/4100/4200/5200, pm2 or the live database. Keep this file pure ASCII.
param(
  [Parameter(Mandatory = $true, Position = 0)][ValidateSet('start', 'stop', 'status')][string]$Action,
  [string]$Root,
  [string]$Build = 'dist-staging',
  [string]$LiveDataRoot = (Join-Path $env:USERPROFILE 'ZolexERP')
)
$ErrorActionPreference = 'Stop'
$here    = Split-Path -Parent $MyInvocation.MyCommand.Path
$repo    = (Resolve-Path (Join-Path $here '..\..')).Path
$pidFile = Join-Path $env:TEMP 'zolex-staging-instance.json'
function PortOwner($port) { $c = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if ($c) { $c.OwningProcess } else { $null } }

if ($Action -eq 'status') { "4012 owner: $(PortOwner 4012) | 8092 owner: $(PortOwner 8092)"; if (Test-Path $pidFile) { Get-Content $pidFile }; return }

if ($Action -eq 'stop') {
  if (-not (Test-Path $pidFile)) { 'no recorded staging instance'; return }
  $rec = Get-Content $pidFile -Raw | ConvertFrom-Json
  foreach ($id in @($rec.frontend, $rec.backend)) {
    $p = Get-CimInstance Win32_Process -Filter "ProcessId=$id" -ErrorAction SilentlyContinue
    # Only the exact processes this script started: a staging build, or a vite preview on 8092. Never pm2's.
    if ($p -and $p.CommandLine -match 'dist-(next|staging)\\index\.js|vite\.js.*--port 8092' -and $p.CommandLine -notmatch 'ProcessContainerFork|pm2') {
      & taskkill /PID $id /T /F | Out-Null
      "stopped PID $id"
    } else { "PID $id is not running (or is no longer the staging process)" }
  }
  Remove-Item $pidFile -ErrorAction SilentlyContinue
  return
}

if (-not $Root) { throw '-Root is required' }
$Root = [IO.Path]::GetFullPath($Root)
$live = [IO.Path]::GetFullPath($LiveDataRoot)
if ($Root.TrimEnd('\').ToLower() -eq $live.TrimEnd('\').ToLower() -or $Root.ToLower().StartsWith(($live.TrimEnd('\') + '\data').ToLower())) { throw "refusing: $Root is the live data root" }
if (-not (Test-Path (Join-Path $Root 'data'))) { throw "$Root has no data folder (restore a backup into it first)" }
if (PortOwner 4012) { throw 'port 4012 is already in use' }
if (PortOwner 8092) { throw 'port 8092 is already in use' }
$entry = Join-Path $repo "backend\$Build\index.js"
if (-not (Test-Path $entry)) { throw "backend build not found: $entry" }
if (-not (Test-Path (Join-Path $repo "frontend\$Build\index.html"))) { throw "frontend build not found: frontend\$Build" }

$run = Join-Path $env:TEMP 'zolex-staging-run'      # an empty working folder: no .env is loaded from here
New-Item -ItemType Directory -Force $run | Out-Null
if (Get-ChildItem $run -Force -Filter '.env*') { throw 'the working folder contains an .env file' }
$rand = { $b = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); ($b | ForEach-Object { $_.ToString('x2') }) -join '' }
$env:NODE_ENV = 'production'; $env:PORT = '4012'; $env:FRONTEND_URL = 'http://localhost:8092'
$env:ZOLEX_DATA_ROOT = $Root; $env:SEED_DEMO_DATA = 'false'; $env:GOOGLE_SHEETS_SYNC_ENABLED = 'false'
Remove-Item Env:GOOGLE_SERVICE_ACCOUNT_KEY_FILE, Env:GOOGLE_API_KEY, Env:GOOGLE_SHEETS_DATABASE_SPREADSHEET_ID, Env:GOOGLE_SHEET_ID -ErrorAction SilentlyContinue
$env:AUTH_SECRET = & $rand; $env:AUTH_REFRESH_SECRET = & $rand
$env:AUTH_RATE_LIMIT_MAX = '5000'; $env:RATE_LIMIT_MAX = '200000'
$log = Join-Path $env:TEMP 'zolex-staging-backend.log'
$be = Start-Process -FilePath 'node' -ArgumentList "`"$entry`"" -WorkingDirectory $run -RedirectStandardOutput $log -RedirectStandardError "$log.err" -WindowStyle Hidden -PassThru
$ok = $false
foreach ($i in 1..180) {
  Start-Sleep -Milliseconds 1000
  try { if ((Invoke-WebRequest -Uri 'http://localhost:4012/api/v1/health' -UseBasicParsing -TimeoutSec 3).StatusCode -eq 200) { $ok = $true; "staging backend healthy after $i s (PID $($be.Id))"; break } } catch {}
  if ($be.HasExited) { "backend exited with code $($be.ExitCode)"; break }
}
if (-not $ok) { Get-Content "$log.err" -Tail 20; throw 'staging backend did not become healthy' }
$env:VITE_API_PROXY = 'http://localhost:4012'
$fe = Start-Process -FilePath 'node' -ArgumentList "`"$repo\frontend\node_modules\vite\bin\vite.js`"", 'preview', '--port', '8092', '--strictPort', '--host', '127.0.0.1', '--outDir', $Build -WorkingDirectory (Join-Path $repo 'frontend') -WindowStyle Hidden -PassThru
foreach ($i in 1..30) { Start-Sleep -Milliseconds 800; try { if ((Invoke-WebRequest -Uri 'http://127.0.0.1:8092/api/v1/health' -UseBasicParsing -TimeoutSec 3).StatusCode -eq 200) { "staging UI on http://127.0.0.1:8092 (PID $($fe.Id))"; break } } catch {} }
Set-Content -Path $pidFile -Value (@{ backend = $be.Id; frontend = $fe.Id; root = $Root; build = $Build; started = (Get-Date -Format 's') } | ConvertTo-Json) -Encoding ascii
'Staging holds a copy of real data: use staging-only passwords there, never a production password, and stop it when the rehearsal is over.'
