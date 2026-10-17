# ZOLEX — Purchase-to-Store Enterprise ERP

**Zeeta Electrical Engineering Pvt. Ltd.**
Purchase Indent → Approval → Purchase Order → Goods Receipt → Management Analysis

---

## Quick start

Two commands, two terminals. Nothing else to install — no database server, no Docker.

```bash
# Terminal 1 — API on http://localhost:4000
cd backend
npm install
npm run dev

# Terminal 2 — web app on http://localhost:5173
cd frontend
npm install
npm run dev
```

Open **http://localhost:5173** and sign in.

The first run creates the database, applies migrations and seeds the permission
catalogue, the six default roles and the two bootstrap administrators, `10221` and
`10422` (Super Admin). There is no default password. Their first-sign-in password is:

- the value of `BOOTSTRAP_ADMIN_PASSWORD` (at least 12 characters), if it is set for
  that first start, or otherwise
- a random one, written once to `bootstrap-admin-password.txt` in the data root
  (`%ZOLEX_DATA_ROOT%`) and never to the log.

> **It is for the first sign-in only.** Each account must set a password of its own
> straight away: until it does, the application shows nothing but the
> change-password screen and the API refuses every other request. Delete
> `bootstrap-admin-password.txt` once both have signed in. A password that has been
> published, or that contains the Employee ID, is refused.

### The database ships **clean**

There is no demo data. Every business table is empty, which is what a production
system should look like on day one.

```bash
cd backend
npm run db:reset      # loads 68 indents, 39 POs, 33 GRNs across seven months
```

That gives you a populated dashboard to explore. Every row it creates is tagged
`seed_tag = 'demo'`, and you can remove it again with certainty:

```bash
npm run db:purify              # dry run — classify and report, change nothing
npm run db:purify -- --apply   # backup, purge, then verify
```

Both routes record a durable marker, so a restart never brings demo data back.

---

## Where things live

```
Purchase_Module/
├── backend/                 Node.js + TypeScript + Express API
├── frontend/                React + TypeScript + Vite web app
├── docs/                    Architecture, API, security, deployment, release audit
└── Zolex_..._SRS_SRC.pdf    The authoritative specification
```

The **database, backups, uploads and logs live outside this folder**, under
`%ZOLEX_DATA_ROOT%` (default `C:\Users\<you>\ZolexERP` / `~/ZolexERP`), as the
specification requires. Nothing in the repository ever contains business data or
secrets.

---

## What it does

| Module | Capability |
|---|---|
| **Management Analysis** | 24 KPIs from one catalogue, trends, supplier/item/department/cost-centre analysis, ageing buckets, exception detection — every figure clickable through to its transactions |
| **Master Data** | Supplier Master, Item Master, and the supporting masters (PO Type, Indent Type, Cost Centre, Department, Item Type, Main/Sub Group, UOM) that drive every dropdown |
| **Purchase Indent** | Header/detail requisition, item auto-population, approval workflow with mandatory rejection reasons |
| **Purchase Order** | Direct PO, indent-based PO, multi-indent consolidation and supplier-wise consolidation — every line traceable to its source indent lines |
| **GRN** | PO-driven receipt, partial and final, with balances that stay mathematically correct |
| **Admin** | Users, roles, 64 granular permissions, import/export, backup & restore, audit log, settings |
| **Google Sheets** | One-way sync into SQL with an ON/OFF header toggle and deterministic conflict handling |

---

## Commands

### Backend

| Command | What it does |
|---|---|
| `npm run dev` | Start the API with hot reload |
| `npm run build` / `npm start` | Compile and run for production |
| `npm test` | Unit + integration tests (80 tests) |
| `npm run typecheck` | Type-check without emitting |
| `npm run migrate` | Apply pending migrations |
| `npm run seed` / `npm run seed:demo` | Seed system data (optionally with demo data) |
| `npm run db:doctor` | **Diagnose the database** — connectivity, volumes, integrity invariants |
| `npm run db:reset` | Rebuild the database from scratch (development only) |
| `npm run db:restore -- <file>` | Restore from a backup, offline |
| `npm run db:purify` | **Classify every business row** — dry run, changes nothing |
| `npm run db:purify -- --apply` | Backup, remove demo/test data, then verify (16 assertions) |
| `npm run db:reset -- --clean` | Rebuild as an **empty production database** (demo seeding disabled) |
| `npm run db:backup` | Create a checksum-verified backup from the command line |
| `npm run migrate -- --check` | Report pending migrations without applying them |

### Deployment (`deploy/`)

| Command | What it does |
|---|---|
| `./deploy/install.sh` | Prepare a host: prerequisites, data directories outside the source tree, generated secrets |
| `docker compose --env-file ./.env.deploy up -d --build` | Build and start PostgreSQL, the API and nginx |
| `./deploy/migrate.sh --clean` | Apply the schema as a clean production database, then verify |
| `./deploy/backup.sh` | Verified backup (pg_dump + portable export) with retention |
| `./deploy/restore.sh --list` | List backups; `--verify <file>` checks one without restoring |

### Frontend

| Command | What it does |
|---|---|
| `npm run dev` | Start the dev server (proxies `/api` to the backend) |
| `npm run build` | Production build |
| `npm run typecheck` | Type-check without emitting |

---

## Configuration

Copy `backend/.env.example` to `backend/.env` and adjust. Every value has a working
default in development; the app validates configuration at boot and fails fast with
a readable message if something required is missing.

The settings that matter most:

| Variable | Purpose |
|---|---|
| `ZOLEX_DATA_ROOT` | Where the database, backups, uploads and logs live. Must be outside this folder. |
| `DB_DRIVER` | `pglite` (embedded, default) or `pg` (a real PostgreSQL server) |
| `DATABASE_URL` | Connection string when `DB_DRIVER=pg` |
| `AUTH_SECRET`, `AUTH_REFRESH_SECRET` | Required in production; auto-generated in development |
| `BOOTSTRAP_ADMIN_PASSWORD` | Optional first-sign-in password (12+ characters) for the bootstrap administrators a new database creates; without it a random one is written to `bootstrap-admin-password.txt` in the data root |
| `TRUST_PROXY` | Which proxies may name the client's address, which sign-in rate limits and the audit trail key on. Unset means loopback, right for a proxy on the same machine; a proxy elsewhere must be named (the docker stack sets `1`) — see [docs/09_DEPLOYMENT.md](docs/09_DEPLOYMENT.md) §4 |
| `GOOGLE_SERVICE_ACCOUNT_KEY_FILE` | Path to a service-account key, stored outside the repository |

**Production runs on a real PostgreSQL server.** See
[docs/09_DEPLOYMENT.md](docs/09_DEPLOYMENT.md) — it explains why, and what the
embedded engine is and is not suitable for.

---

## Documentation

| Document | Contents |
|---|---|
| [00_PROJECT_AUDIT.md](docs/00_PROJECT_AUDIT.md) | Workspace and toolchain audit, risk register |
| [01_ARCHITECTURE_DECISIONS.md](docs/01_ARCHITECTURE_DECISIONS.md) | Every significant decision and its reasoning |
| [02_IMPLEMENTATION_STATUS.md](docs/02_IMPLEMENTATION_STATUS.md) | What is built, tested and verified |
| [03_CHANGELOG.md](docs/03_CHANGELOG.md) | Release history |
| [04_KNOWN_ISSUES.md](docs/04_KNOWN_ISSUES.md) | Honest limitations and their workarounds |
| [05_TEST_STATUS.md](docs/05_TEST_STATUS.md) | Test inventory and results |
| [06_DATABASE.md](docs/06_DATABASE.md) | Schema, balance views, integrity rules |
| [07_API.md](docs/07_API.md) | Endpoint reference |
| [08_SECURITY.md](docs/08_SECURITY.md) | Security model and controls |
| [09_DEPLOYMENT.md](docs/09_DEPLOYMENT.md) | Production deployment and operations |
| [10_RELEASE_AUDIT.md](docs/10_RELEASE_AUDIT.md) | Requirement-by-requirement traceability |

### Production hardening (v1.1)

| Document | Contents |
|---|---|
| [FINAL_PRODUCTION_RELEASE_AUDIT.md](docs/FINAL_PRODUCTION_RELEASE_AUDIT.md) | **Start here.** Verdict, conditions, scorecard |
| [FINAL_GAP_AUDIT.md](docs/FINAL_GAP_AUDIT.md) | Requirement-by-requirement, with the deliberate deviations |
| [FINAL_FORENSIC_INVENTORY.md](docs/FINAL_FORENSIC_INVENTORY.md) | Source and database audit for demo/hard-coded data |
| [FINAL_DATA_PURIFICATION_REPORT.md](docs/FINAL_DATA_PURIFICATION_REPORT.md) | Before/after counts and verification evidence |
| [FINAL_GOOGLE_SHEETS_PRODUCTION_GUIDE.md](docs/FINAL_GOOGLE_SHEETS_PRODUCTION_GUIDE.md) | **Copy-paste headers for all 9 tabs**, service-account setup, troubleshooting |
| [FINAL_UI_UX_AUDIT.md](docs/FINAL_UI_UX_AUDIT.md) | Design system, screen-by-screen findings, accessibility |
| [FINAL_SECURITY_AUDIT.md](docs/FINAL_SECURITY_AUDIT.md) | 14 areas, verified by execution |

---

## The two ideas worth knowing

**Balances are derived, never stored.** `pending_qty` and `pending_grn_qty` are SQL
views computed from source references and posted receipts. Operational screens,
server-side validation and the analytics engine all read those same views, which is
why the dashboard reconciles with the transaction lists by construction rather than
by luck.

**The database owns the money maths.** `final_rate` and `amount` are
`GENERATED ALWAYS AS … STORED` columns computed by PostgreSQL from quantity, rate and
discount. They cannot drift from their inputs and cannot be forged by a client.

---

Zeeta Electrical Engineering Pvt. Ltd. · ZOLEX Purchase-to-Store ERP v1.0
