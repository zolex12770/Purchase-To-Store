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

The backend trusts `X-Forwarded-For` only from loopback (`trust proxy = loopback`), so
behind this nginx on the same host `req.ip` is the real client for rate limiting and
audit, and a client reaching the API port directly cannot spoof the header. A proxy
on another host (or in another container) is not trusted: the API would see the
proxy's own address.

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
