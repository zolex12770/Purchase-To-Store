# 09 — Deployment & Operations

---

## 1. Requirements

| | Development / evaluation | Production |
|---|---|---|
| Node.js | ≥ 20 (built and tested on 22.14) | ≥ 20 LTS |
| Database | Embedded — nothing to install | **PostgreSQL 14+ server** |
| Reverse proxy | — | nginx / IIS / Caddy terminating TLS |
| Disk | ~500 MB | Sized for data + backup retention |

---

## 2. Development

```bash
cd backend  && npm install && npm run dev    # http://localhost:4000
cd frontend && npm install && npm run dev    # http://localhost:5173
```

The first backend start creates the data directory, applies migrations, seeds the
permission catalogue, roles, bootstrap admins, settings and sheet mappings, then
loads a demo dataset. Set `SEED_DEMO_DATA=false` to skip the demo data.

The Vite dev server proxies `/api` to the backend, so the browser sees one origin —
no CORS preflight and no backend URL compiled into the bundle.

---

## 3. Choosing the database driver

This is the most consequential deployment decision.

### `DB_DRIVER=pglite` (default)

Real PostgreSQL 18 compiled to WebAssembly, running inside the API process, storing
to a directory. Genuine `NUMERIC`, foreign keys, transactions, `FOR UPDATE`, CTEs and
window functions — the same SQL as a server.

**Right for:** development, evaluation, demos, and small single-node deployments
where the operator can stop the service cleanly.

**Understand before relying on it:**

- **Single writer.** One process at a time. A `.zolex.lock` heartbeat file enforces
  this; a starting process waits up to 20 s for a departing one, so restarts are
  seamless, and a lock whose heartbeat stopped is reclaimed automatically.
- **A force-kill can corrupt it.** `taskkill /F`, `kill -9` or a power loss mid-write
  can leave the write-ahead log without a valid checkpoint, which PostgreSQL cannot
  auto-repair. The driver detects this and prints an actionable diagnosis; recovery
  is `npm run db:restore -- <file>` or `npm run db:reset`.
- **No horizontal scale.** The database is inside the process.

**Stop the service with SIGTERM/Ctrl+C, never a force-kill.**

### `DB_DRIVER=pg` — recommended for production

```env
DB_DRIVER=pg
DATABASE_URL=postgresql://zolex:<password>@db-host:5432/zolex_erp
DB_POOL_MAX=20
```

A server manages its own lifecycle, survives client kills, supports multiple API
nodes, and gives you `pg_dump`, streaming replication and point-in-time recovery.

**The SQL is identical.** Switching is a two-line `.env` change plus
`npm run migrate` — no code changes, because the driver adapter exposes only
`query`/`transaction`/`close` and the migrations are ordinary PostgreSQL.

To migrate existing data: create a backup from the Admin screen while on `pglite`,
switch the driver, run `npm run migrate`, then `npm run db:restore -- <file>`.

---

## 4. Production build

```bash
# Backend
cd backend
npm ci
npm run build          # → dist/
NODE_ENV=production node dist/index.js

# Frontend
cd frontend
npm ci
npm run build          # → dist/  (static files)
```

Serve `frontend/dist` from your web server and proxy `/api` to the backend.

### nginx sketch

```nginx
server {
  listen 443 ssl http2;
  server_name erp.example.com;

  ssl_certificate     /etc/ssl/certs/zolex.crt;
  ssl_certificate_key /etc/ssl/private/zolex.key;

  root /var/www/zolex;
  index index.html;

  # The SPA owns client-side routing.
  location / { try_files $uri $uri/ /index.html; }

  location /api/ {
    proxy_pass         http://127.0.0.1:4000;
    proxy_http_version 1.1;
    proxy_set_header   Host              $host;
    proxy_set_header   X-Real-IP         $remote_addr;
    proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header   X-Forwarded-Proto $scheme;
    proxy_read_timeout 300s;   # long enough for a sync or a large import
  }

  location ~* \.(js|css|woff2|svg|png)$ {
    expires 1y;
    add_header Cache-Control "public, immutable";
  }
}
```

By default (`TRUST_PROXY` unset) the backend trusts `X-Forwarded-For` only from
loopback, so behind this nginx on the same host `req.ip` is the real client for rate
limiting and audit, and a client reaching the API port directly cannot spoof the
header. A proxy on another host or in a container must be named in `TRUST_PROXY`:
its address or subnet (comma-separated), or the number of proxy hops when nothing
else can reach the API port — `deploy/docker-compose.yml` sets `1` for its nginx
container. Otherwise the API sees the proxy's own address for every user, and the
sign-in rate limit becomes one budget for the whole site: 20 mistyped passwords
anywhere close sign-in for everyone for 15 minutes. Never use `uniquelocal` on a host
whose LAN is itself a private range (every LAN client could name any address);
`true` is refused at boot. The value in force is logged at start-up
(`Trust proxy  :`).

---

## 5. Production environment

```env
NODE_ENV=production
PORT=4000
FRONTEND_URL=https://erp.example.com

ZOLEX_DATA_ROOT=/var/lib/zolex          # backed up; restricted permissions

DB_DRIVER=pg
DATABASE_URL=postgresql://zolex:<password>@db-host:5432/zolex_erp

# node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
AUTH_SECRET=<48 random bytes>
AUTH_REFRESH_SECRET=<a different 48 random bytes>

GOOGLE_SHEET_ID=<sheet id>
GOOGLE_SERVICE_ACCOUNT_KEY_FILE=/etc/zolex/service-account.json
GOOGLE_SYNC_INTERVAL_MINUTES=15

RATE_LIMIT_MAX=1000
AUTH_RATE_LIMIT_MAX=20
# Only when the reverse proxy is NOT on this machine (see §4), e.g. its address:
# TRUST_PROXY=10.0.0.5
LOG_LEVEL=info
SEED_DEMO_DATA=false
```

The server validates all of this at boot and **exits** with a readable message rather
than starting half-configured. In production it refuses to start without proper
secrets.

---

## 6. Running as a service

### systemd

```ini
[Unit]
Description=ZOLEX Purchase-to-Store ERP API
After=network.target postgresql.service

[Service]
Type=simple
User=zolex
WorkingDirectory=/opt/zolex/backend
EnvironmentFile=/etc/zolex/zolex.env
ExecStart=/usr/bin/node dist/index.js
Restart=on-failure
RestartSec=5

# Graceful shutdown matters — see §3.
KillSignal=SIGTERM
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
```

### Windows

Use a wrapper that sends **CTRL+BREAK or SIGTERM** rather than a hard terminate
(`nssm set ZolexERP AppStopMethodConsole 15000`). The application handles SIGINT and
SIGTERM, draining in-flight requests and closing the database cleanly.

---

## 7. Backups (SRS §23)

- Create from **Admin → Backup & Restore**, or `POST /api/v1/backup`.
- Written to `$ZOLEX_DATA_ROOT/backups` as timestamped JSON with a SHA-256 checksum
  and a `backup_metadata` row.
- **Verify** re-computes the checksum; **Restore** refuses a file that has changed.
- Restore is one transaction, permission-gated and audited.
- Offline recovery: `npm run db:restore -- <filename>` — the path that works when the
  database itself will not open.

Retention defaults to 30 days / 50 backups (whichever is larger), configurable in
Settings.

**Recommended:** a nightly job that calls the backup endpoint (or `pg_dump` when on a
real server), copies the file off-box, and **restores it into a scratch environment
once a month**. An untested backup is not a backup.

---

## 8. Health and observability

```
GET /api/v1/health
```

Returns service identity, environment, database driver, reachability and query
latency. `503` when the database is unreachable — wire it to your load balancer and
monitor.

Structured NDJSON logs are written to `$ZOLEX_DATA_ROOT/logs/zolex-YYYY-MM-DD.log`
with passwords, tokens and secrets redacted. Every request carries an `x-request-id`
that also appears on error responses, so a user's screenshot maps to a log line.

`npm run db:doctor` gives an operator a one-command health report: connectivity,
migration state, record volumes and all integrity invariants.

---

## 9. Scaling notes (SRS §30)

Already in place: server-side pagination and sorting on every list, indexed filter
dimensions, aggregate SQL for dashboards, no N+1 (related data is fetched in one
query and attached in memory), connection pooling on `pg`, debounced search, route-
level code splitting.

When you outgrow one node:

1. Move to `DB_DRIVER=pg` — required for more than one API process.
2. Move rate limiting to a shared store (Redis); it is currently in-process, so N
   nodes multiply the effective limit by N.
3. Move long-running sync and import jobs to a worker process; they already run
   asynchronously and record their own job rows.
4. Add read replicas for analytics if dashboards begin to compete with transactions.

---

## 10. Upgrades

```bash
git pull
cd backend  && npm ci && npm run build
cd frontend && npm ci && npm run build
# Take a backup FIRST, then:
cd backend && npm run migrate
systemctl restart zolex-erp
```

Migrations are additive and checksum-verified. Editing an applied migration is a hard
error — add a new one instead. Always back up before upgrading.

---

## 11. This server: Windows + pm2 — deploy, verify, roll back

The production ERP runs on one Windows server under pm2: `zolex-purchase-backend`
(`backend/dist/index.js`, port 4001) and `zolex-purchase-frontend` (`vite preview` of
`frontend/dist`, port 8080, which also proxies `/api` to 4001). The same pm2 runs other
systems (`sales-module` on 4100, `erp-sales-planning-production` on 4200, and a planning
server on 5200). **Never** stop, restart or reconfigure those, and never run
`pm2 restart all`, `pm2 delete all` or `pm2 save` as part of a Purchase deploy.

The scripts are in `deploy/windows/` (pure ASCII: Windows PowerShell 5.1 reads `.ps1`
files in the ANSI code page).

### 11.1 Build

```powershell
cd backend
npx tsc -p tsconfig.json --outDir dist-next
node -e "require('fs').cpSync('src/db/migrations','dist-next/db/migrations',{recursive:true}); require('fs').cpSync('src/assets','dist-next/assets',{recursive:true})"
cd ..\frontend
npx tsc -b
npx vite build --outDir dist-next
```

### 11.2 Rehearse on an isolated copy first

1. Restore the latest backup into a scratch folder (the live database is never opened):
   `cd backend; npx tsx src\db\cli-verify-restore.ts <backup file> --keep`.
2. Build a second time with `--outDir dist-staging` and start the copy:
   `deploy\windows\staging-instance.ps1 start -Root <kept folder>` (API 4012, UI 8092, no Google access).
3. Exercise the changed workflows there; stop it with `staging-instance.ps1 stop`.

### 11.3 Deploy

1. **Backup:** Admin › Backup & Restore › Create backup, then Verify.
2. **Backend:** `deploy\windows\deploy-backend.ps1 -Migration <newest migration file>`. It
   checks the backup is less than 30 minutes old, waits for a moment outside the 15-minute
   sheet sync, stops only `zolex-purchase-backend`, copies the whole data folder to
   `<data root>\backups\data-copy-<stamp>` and compares it, swaps `dist` → `dist-prev-<stamp>`
   and `dist-next` → `dist`, starts the app and waits for `/api/v1/health`. If the new
   build does not come up it puts the previous build back by itself.
3. **Frontend:** `deploy\windows\deploy-frontend.ps1` swaps the folders without stopping the
   preview and keeps the previous build's assets reachable for open tabs.
4. **Verify:** health on 4001 and through 8080, sign in, open the changed screens, check
   `pm2 logs zolex-purchase-backend --lines 50` for errors, and that 4100, 4200 and 5200
   still answer.

### 11.4 Roll back

- **Code only (normal):** `deploy\windows\rollback-backend.ps1 -PrevBuild dist-prev-<stamp>`
  (the stamp is in `deploy\windows\deploy-backend-last.json`). Migrations are additive, so a
  previous build runs on a newer schema; this was tested on 2026-10-18 with the `1a21b6d`
  build on a copy at schema 030 (every module read and a write round trip succeeded).
  Frontend: rename `frontend\dist` to `dist-rolledback-<stamp>` and
  `frontend\dist-prev-<stamp>` back to `dist`.
- **Data (exceptional):** prefer the application's audited undo endpoints, or Admin ›
  Backup › Restore of a verified backup. As a last resort,
  `rollback-backend.ps1 -PrevBuild <...> -RestoreDataCopy <data-copy folder> -AcceptLosingChangesAfterTheCopy`
  moves the live data folder aside (never deletes it) and copies the pre-deploy copy in;
  everything entered after the copy is then absent from the live database.
