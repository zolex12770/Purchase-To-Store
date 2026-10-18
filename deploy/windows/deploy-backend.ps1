# Deploys ONLY the Purchase-to-Store backend (pm2 app "zolex-purchase-backend", port 4001) on the Windows server.
# Touches nothing else: no other pm2 app, no "pm2 save", no ecosystem change. The live database folder is only
# COPIED (while this app is stopped) to a new, uniquely named folder - never modified, moved or overwritten.
#
#   1. Build:   cd backend; npx tsc -p tsconfig.json --outDir dist-next
#               then copy src\db\migrations and src\assets into dist-next (see docs/09_DEPLOYMENT.md section 11)
#   2. Backup:  Admin > Backup & Restore > Create backup, then Verify (within the last 30 minutes)
#   3. Run:     powershell -NoProfile -ExecutionPolicy Bypass -File deploy\windows\deploy-backend.ps1 -Migration 030_store_grn_link_holds.sql
#
# The previous build is kept as backend\dist-prev-<stamp> and the database copy as <data root>\backups\data-copy-<stamp>;
# both are written to deploy-backend-last.json next to this script. Roll back with rollback-backend.ps1.
# Keep this file pure ASCII: Windows PowerShell 5.1 reads scripts in the ANSI code page.
param(
  [Parameter(Mandatory = $true)][string]$Migration,
  [string]$DataRoot = (Join-Path $env:USERPROFILE 'ZolexERP'),
  [int]$SyncIntervalMinutes = 15,
  [switch]$SkipBackupCheck
)
$ErrorActionPreference = 'Stop'
$here    = Split-Path -Parent $MyInvocation.MyCommand.Path
$repo    = (Resolve-Path (Join-Path $here '..\..')).Path
$backend = Join-Path $repo 'backend'
$app     = 'zolex-purchase-backend'
$data    = Join-Path $DataRoot 'data'
$stamp   = Get-Date -Format 'yyyyMMdd-HHmmss'
$prev    = "dist-prev-$stamp"
$copy    = Join-Path $DataRoot "backups\data-copy-$stamp"

function Health { try { (Invoke-WebRequest -UseBasicParsing -TimeoutSec 4 'http://localhost:4001/api/v1/health').StatusCode -eq 200 } catch { $false } }
function PortOwner($port) { $c = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if ($c) { $c.OwningProcess } else { $null } }
function Tree($dir) { $f = Get-ChildItem $dir -Recurse -File -Force -ErrorAction SilentlyContinue; "$($f.Count) files / $((($f | Measure-Object Length -Sum).Sum))" }

# 0. Preconditions.
if (-not (Test-Path "$backend\dist-next\index.js")) { throw 'backend\dist-next is not built.' }
if (-not (Test-Path "$backend\dist-next\db\migrations\$Migration")) { throw "dist-next lacks migration $Migration (copy src\db\migrations into it)." }
if (-not (Test-Path $data)) { throw "No database folder at $data." }
if (Test-Path $copy) { throw "$copy already exists - refusing to overwrite." }
if (-not $SkipBackupCheck) {
  $newest = Get-ChildItem (Join-Path $DataRoot 'backups') -Filter 'zolex-backup-*.json' -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (-not $newest -or ((Get-Date) - $newest.LastWriteTime).TotalMinutes -gt 30) {
    throw 'No backup from the last 30 minutes. Create and verify one in Admin > Backup & Restore first (or pass -SkipBackupCheck to rely on the data copy alone).'
  }
  "backup: $($newest.Name) ($([math]::Round($newest.Length / 1MB, 1)) MB, $([int]((Get-Date) - $newest.LastWriteTime).TotalMinutes) min old)"
}
$ownerPid = PortOwner 4001
$list = pm2 jlist | Out-String
$info = $list | node -e "const s=require('fs').readFileSync(0,'utf8');const a=JSON.parse(s.slice(s.indexOf('[')));const p=a.find(x=>x.name===process.argv[1]);console.log(p?p.pid+'|'+p.pm2_env.pm_cwd+'|'+p.pm2_env.pm_uptime:'NONE')" $app
if ($info -eq 'NONE' -or -not $info) { throw "pm2 app $app not found." }
$pmPid, $pmCwd, $pmUptime = $info -split '\|'
if ([int]$pmPid -ne [int]$ownerPid) { throw "Port 4001 is owned by PID $ownerPid, but pm2 $app is PID $pmPid. Not proceeding." }
if ((Resolve-Path $pmCwd).Path -ne (Resolve-Path $backend).Path) { throw "pm2 $app runs from $pmCwd, not $backend. Not proceeding." }
"precheck ok: $app = PID $ownerPid, healthy=$(Health)"
"protected ports before: 4100=$(PortOwner 4100) 4200=$(PortOwner 4200) 5200=$(PortOwner 5200)"

# 1. Quiet moment. The business-sheet sync runs every $SyncIntervalMinutes minutes counted from the process start
#    and takes about 70 s; stay out of [tick - 30 s, tick + 120 s]. The Google replica ticks at ~:00-:08 of each minute.
$startMs = [int64]$pmUptime
while ($true) {
  $nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $period = $SyncIntervalMinutes * 60000
  $sinceTick = ($nowMs - $startMs) % $period
  $toNext = $period - $sinceTick
  $sec = (Get-Date).ToUniversalTime().Second
  if ($sinceTick -gt 120000 -and $toNext -gt 30000 -and $sec -ge 18 -and $sec -le 40) { break }
  Start-Sleep -Milliseconds 500
}
"quiet window reached at $((Get-Date).ToUniversalTime().ToString('HH:mm:ss')) UTC"

# 2. Stop ONLY this app.
pm2 stop $app | Out-Null
$deadline = (Get-Date).AddSeconds(20)
while ((PortOwner 4001) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 300 }
if (PortOwner 4001) { throw 'Port 4001 is still in use after pm2 stop. Nothing was swapped.' }
"stopped $app; port 4001 is free"

# 3. Complete physical copy of the database folder while nothing writes to it: the recovery point.
$t = Get-Date
robocopy $data $copy /E /COPY:DAT /R:1 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
$src = Tree $data; $dst = Tree $copy
"data copy: $copy ($dst) in $([int]((Get-Date) - $t).TotalSeconds) s; source $src"
if ($src -ne $dst) {
  pm2 start $app | Out-Null
  throw "The data copy does not match the source ($src vs $dst). Old build restarted; nothing was swapped."
}

# 4. Swap the build. The old build is KEPT as the rollback copy.
Rename-Item "$backend\dist" $prev
Rename-Item "$backend\dist-next" 'dist'
"swapped: previous build kept at backend\$prev"

# 5. Start and wait for health; roll the code back on its own if the new build does not come up.
pm2 start $app | Out-Null
$ok = $false
foreach ($i in 1..180) { if (Health) { $ok = $true; break }; Start-Sleep -Seconds 1 }
if (-not $ok) {
  'NEW BUILD DID NOT BECOME HEALTHY - rolling back the code (the database copy is untouched)'
  pm2 stop $app | Out-Null
  Start-Sleep -Seconds 2
  Rename-Item "$backend\dist" "dist-failed-$stamp"
  Rename-Item "$backend\$prev" 'dist'
  pm2 start $app | Out-Null
  foreach ($i in 1..90) { if (Health) { break }; Start-Sleep -Seconds 1 }
  "rolled back to the previous build; healthy=$(Health)"
  exit 2
}
"NEW BUILD HEALTHY; port 4001 owner PID $(PortOwner 4001)"
(Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 'http://localhost:4001/api/v1/health').Content
"protected ports after: 4100=$(PortOwner 4100) 4200=$(PortOwner 4200) 5200=$(PortOwner 5200)"
Set-Content (Join-Path $here 'deploy-backend-last.json') (@{ prev = $prev; stamp = $stamp; dataCopy = $copy } | ConvertTo-Json) -Encoding ascii
"recorded rollback details in deploy\windows\deploy-backend-last.json"
