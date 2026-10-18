# Rolls the Purchase-to-Store backend (pm2 app "zolex-purchase-backend", port 4001) back to a previous build.
#
# CODE-ONLY rollback (the normal case; keeps every record entered since the deploy):
#   powershell -NoProfile -ExecutionPolicy Bypass -File deploy\windows\rollback-backend.ps1 -PrevBuild dist-prev-20261018-101500
# Migrations are additive (new tables, widened CHECKs), so a previous build runs on the newer schema: its
# migration runner applies only the files it knows and ignores newer ones. This was proven on 2026-10-18 with
# the 1a21b6d build on a schema-030 copy (all reads 200, a write round trip succeeded).
#
# DATA rollback (only when the data itself must go back, for example a bad repair that cannot be undone):
#   ... -PrevBuild dist-prev-<stamp> -RestoreDataCopy <data root>\backups\data-copy-<stamp> -AcceptLosingChangesAfterTheCopy
# The current data folder is MOVED aside to data-before-rollback-<stamp> (never deleted) and the copy is copied in.
# Everything entered after the copy was taken is then absent from the live database (still in the moved folder).
# Prefer the application's own undo endpoints (they are audited) or a verified backup restore where possible.
#
# Touches only this pm2 app. Keep this file pure ASCII (Windows PowerShell 5.1).
param(
  [Parameter(Mandatory = $true)][string]$PrevBuild,
  [string]$RestoreDataCopy,
  [switch]$AcceptLosingChangesAfterTheCopy,
  [string]$DataRoot = (Join-Path $env:USERPROFILE 'ZolexERP')
)
$ErrorActionPreference = 'Stop'
$here    = Split-Path -Parent $MyInvocation.MyCommand.Path
$repo    = (Resolve-Path (Join-Path $here '..\..')).Path
$backend = Join-Path $repo 'backend'
$app     = 'zolex-purchase-backend'
$data    = Join-Path $DataRoot 'data'
$stamp   = Get-Date -Format 'yyyyMMdd-HHmmss'

function Health { try { (Invoke-WebRequest -UseBasicParsing -TimeoutSec 4 'http://localhost:4001/api/v1/health').StatusCode -eq 200 } catch { $false } }
function PortOwner($port) { $c = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if ($c) { $c.OwningProcess } else { $null } }
function Tree($dir) { $f = Get-ChildItem $dir -Recurse -File -Force -ErrorAction SilentlyContinue; "$($f.Count) files / $((($f | Measure-Object Length -Sum).Sum))" }

if ($PrevBuild -notmatch '^dist-prev-\d{8}-\d{6}$') { throw 'PrevBuild must be a dist-prev-<yyyyMMdd-HHmmss> folder name.' }
if (-not (Test-Path "$backend\$PrevBuild\index.js")) { throw "backend\$PrevBuild\index.js not found." }
if ($RestoreDataCopy) {
  if (-not $AcceptLosingChangesAfterTheCopy) { throw 'A data rollback discards every change made after the copy; pass -AcceptLosingChangesAfterTheCopy to confirm.' }
  if (-not (Test-Path $RestoreDataCopy)) { throw "$RestoreDataCopy not found." }
}
"protected ports before: 4100=$(PortOwner 4100) 4200=$(PortOwner 4200) 5200=$(PortOwner 5200)"

pm2 stop $app | Out-Null
$deadline = (Get-Date).AddSeconds(20)
while ((PortOwner 4001) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 300 }
if (PortOwner 4001) { throw 'Port 4001 is still in use after pm2 stop. Nothing was changed.' }
"stopped $app"

if ($RestoreDataCopy) {
  $aside = Join-Path $DataRoot "data-before-rollback-$stamp"
  Rename-Item $data $aside
  robocopy $RestoreDataCopy $data /E /COPY:DAT /R:1 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
  $src = Tree $RestoreDataCopy; $dst = Tree $data
  if ($src -ne $dst) {
    Remove-Item $data -Recurse -Force -Confirm:$false
    Rename-Item $aside $data
    pm2 start $app | Out-Null
    throw "Restored copy does not match ($src vs $dst); the original data folder was put back and the app restarted."
  }
  "data restored from $RestoreDataCopy ($dst); the replaced folder is kept at $aside"
}

Rename-Item "$backend\dist" "dist-rolledback-$stamp"
Rename-Item "$backend\$PrevBuild" 'dist'
"code: backend\dist is now $PrevBuild; the build that was live is kept at backend\dist-rolledback-$stamp"

pm2 start $app | Out-Null
$ok = $false
foreach ($i in 1..180) { if (Health) { $ok = $true; break }; Start-Sleep -Seconds 1 }
"healthy after rollback: $ok"
if ($ok) { (Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 'http://localhost:4001/api/v1/health').Content }
"protected ports after: 4100=$(PortOwner 4100) 4200=$(PortOwner 4200) 5200=$(PortOwner 5200)"
if (-not $ok) { exit 2 }
