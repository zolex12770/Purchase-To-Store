# 03 — Changelog

All notable changes to the ZOLEX Purchase-to-Store ERP.
Format follows [Keep a Changelog](https://keepachangelog.com/); versions follow
[Semantic Versioning](https://semver.org/).

---

## [1.1.0] — 25 August 2026

Production hardening: complete UI transformation, data purification tooling,
deployment package, and the load testing that v1.0 left open.

**No business rule changed.** Quantity control, balance definitions, status
machines, document numbering, the approval workflow, the RBAC model, audit
design and the database's authoritative role over money are all untouched. The
309 automated checks still pass, and none was weakened to accommodate this work.

### Added — Design system v2

- **Complete design-system replacement.** `tokens.css` and `base.css` rewritten
  with 9 colour ramps (11 steps each), 7 semantic roles, 6 module identities,
  11 gradients, 9 elevation levels and 13 keyframe animations. Every existing
  class name was preserved, so 41 components inherited the new language without
  individual edits.
- **Dark / light / follow-system theming.** `ThemeProvider` stamps `data-theme`
  on the root element; an inline script in `index.html` applies the saved choice
  **before first paint**, so the app never flashes the wrong palette. Dark ramps
  invert deliberately — `--brand-500` resolves to the readable mid-tone in each
  theme, so no component branches on the theme in JavaScript.
- **Module identity.** Each ERP area owns a signature colour (dashboard violet,
  masters sky, indent indigo, PO gold, GRN teal, admin rose), applied to the
  sidebar rail, icons and card accents.
- **KPI cards** with gradient icon medallions, count-up figures and tinted trend
  pills. `useCountUp` animates only on first appearance and honours
  `prefers-reduced-motion`.
- **Landing and login** rebuilt with animated gradient meshes, masked
  engineering grids, gradient headlines and viewport-triggered statistics.
- Glass surfaces on the top bar, filter bar and overlays — deliberately **not**
  behind data grids, where low-contrast translucency harms readability.
- Sora added as the display face alongside Inter and JetBrains Mono.

### Added — Data purification

- **Migration `006_data_classification`.** Adds an explicit, indexed `seed_tag`
  column to the seven tables holding business data, replacing a fragile
  `[DEMO]`-prefix convention. Backfills only where classification is *provable*
  from the data; anything else is left for a human.
- **`npm run db:purify`.** Classifies every business row, and with `--apply`
  takes a verified backup, purges demo/test data in one transaction, and asserts
  16 invariants afterwards. Default is a dry run. Rows it cannot classify are
  reported, never deleted.
- **`npm run db:reset -- --clean`** creates an empty production database, and
  records that demo seeding must never run on it.
- **`npm run db:backup`** — the checksum-verified export, available from cron.
- **`npm run migrate -- --check`** reports pending migrations without applying
  them, and flags any applied migration whose file has since been edited.

### Added — Deployment package

- `deploy/docker-compose.yml` — PostgreSQL 16, API and nginx with healthchecks,
  named volumes and no secrets in the file.
- `deploy/Dockerfile.backend` — multi-stage, non-root, `tini` so SIGTERM reaches
  Node and the database closes cleanly.
- `deploy/Dockerfile.frontend` — multi-stage; the runtime image is static files
  only.
- `deploy/nginx.conf` — SPA serving, API proxy, CSP, security headers, gzip,
  cache policy, per-endpoint rate limits, TLS block ready to enable.
- `deploy/install.sh`, `migrate.sh`, `backup.sh`, `restore.sh` — install refuses
  to place the data root inside the source tree; backup verifies what it writes;
  restore dumps the current database before overwriting it.
- `deploy/.env.deploy.example` with every variable documented.

### Fixed

- **Login headline was invisible.** The new stylesheet pinned
  `h1…h6 { color: var(--text-primary) }`, rendering the headline near-black on
  the dark navy login panel — roughly 1.2:1 contrast. Headings now inherit,
  which corrected every dark-panel heading at once.
- **268 px horizontal overflow** on the dashboard: `.app-main { width: 100% }`
  on a wrapper already carrying `margin-left: var(--sidebar-w)`.
- **Every KPI label truncated** ("TOTAL PO V…") after the icon medallion took
  the label's width — strictly worse than v1. Labels now lead and wrap to two
  lines with the height reserved so cards still align.
- **Landing page broke in dark mode** — it pinned a white background while its
  card children followed the theme.
- **Purification was undone by the next restart.** `SEED_DEMO_DATA` defaults to
  `true` outside production, so a start-up re-created the demo rows it found
  missing. A durable `data.purified_at` marker now outranks the environment
  variable entirely.
- **Demo items and users carried no marker at all**, so purification could not
  distinguish them from real records. Now tagged at creation; correctly
  classified demo users rose from 2 of 7 to 7 of 7.
- **Purge deleted masters before the users referencing them**, stranding four
  department lookups behind a guard that was protecting them from data about to
  be deleted. Users are now removed first.
- **`db:doctor` reported live database locks as stale.** It parsed the lock file
  as a bare PID while the driver wrote JSON, so `Number(...)` gave `NaN` and the
  liveness probe always failed. An operator could have been told it was safe to
  clear a lock another process was actively holding. Both now share one
  exported rule.
- **CORS accepted `http://localhost:5173` in production.** Development origins
  are now included only outside production.
- **Express `clearCookie` deprecation warning** on every logout — cookie
  attributes and lifetime are now separate, sharing one definition.
- Removed a needless `LEFT JOIN` from the item count query; no filter referenced
  the joined table.

### Documentation

- `FINAL_FORENSIC_INVENTORY.md` — exhaustive source and database audit
- `FINAL_DATA_PURIFICATION_REPORT.md` — before/after with verification evidence
- `FINAL_GOOGLE_SHEETS_PRODUCTION_GUIDE.md` — copy-paste headers for all 9 tabs,
  service-account setup, troubleshooting
- `FINAL_GAP_AUDIT.md` — requirement-by-requirement, including the deliberate
  deviations and the conflicting sheet specification
- `FINAL_UI_UX_AUDIT.md` — measured, screen by screen
- `FINAL_SECURITY_AUDIT.md` — 14 areas, 1 issue found and fixed
- `FINAL_PRODUCTION_RELEASE_AUDIT.md` — verdict **CONDITIONAL GO**

### Measured

Load testing, which v1.0 recorded as not performed:

- Single user: every read endpoint **under 120 ms** (health 6 ms, dashboard
  KPIs 34 ms, indent list 89 ms). Authentication 753 ms, dominated by bcrypt-12.
- Six concurrent users: sustained mixed workload **217 ms p50 / 443 ms p99 at
  21.3 req/s**, with **0 genuine errors** and 3,033 requests correctly refused
  by the rate limiter.
- Latency multiplies under concurrency because PGlite is single-writer and
  serialises queries — the measured evidence behind requiring `DB_DRIVER=pg` in
  production.

---

## [1.0.0] — 25 August 2026

First release. Complete Purchase-to-Store ERP built against
`Zolex_Purchase_to_Store_ERP_Master_SRS_SRC.pdf` v1.0.

### Added — Platform

- **Dual-driver data layer** (ADR-001): one PostgreSQL dialect, two interchangeable
  backends — embedded PGlite (zero setup) or a real PostgreSQL server. Same SQL, same
  migrations.
- Five checksum-verified migrations covering identity, RBAC, masters, transactions,
  operations and the balance views.
- **Authoritative balance views** (ADR-005) read by operational screens, validation
  and analytics alike, so the dashboard reconciles with transaction lists by
  construction.
- **Database-generated money columns** (ADR-004): `final_rate` and `amount` are
  computed by PostgreSQL and cannot drift or be forged.
- Document numbering service with row-locked counters and unique constraints.
- Structured logging with secret redaction, written outside the repository.
- Health endpoint with database reachability and latency.

### Added — Security

- JWT access tokens with rotating, server-revocable refresh tokens stored hashed.
- 64 permissions across 13 modules; 6 default roles; custom roles supported.
- Server-side permission enforcement on every guarded route.
- Failed-login lockout, enumeration-resistant sign-in, forced bootstrap rotation.
- Complete audit trail with before/after values, written inside the caller's
  transaction.
- Parameterised SQL throughout; allow-listed sort columns and analytics dimensions.
- CSV formula-injection protection on export.

### Added — Modules

- **Master Data** — Supplier Master, Item Master, and 10 supporting master categories
  in one table with cascading parent/child (ADR-014). Auto-population endpoints.
- **Purchase Indent** — header/detail form, approval workflow, mandatory rejection
  reasons, separation of duties, approval history.
- **Purchase Order** — direct, indent-based, multi-indent consolidation and
  supplier-wise consolidation, all through one payload; per-line source traceability.
- **GRN** — PO-driven partial and final receipt, draft/post lifecycle, cancellation
  that reverses balances.
- **Management Analysis** — 24 catalogue-defined KPIs, trends, 9 breakdown dimensions,
  ageing, supplier performance, 8 exception types, clickable drill-down that preserves
  filters.
- **Admin** — users, roles, permissions, audit viewer with diffs, import/export,
  backup and restore, settings.
- **Google Sheets sync** — header toggle, declarative mappings with header aliases,
  masters-first ordering, conflict recording that never overwrites approved documents.

### Added — Frontend

- Bespoke design system: tokens, primitives, premium enterprise visual language.
- Application shell with sidebar, global search (Ctrl+K), sync toggle, notifications.
- DataTable with search, sort, server-side pagination, column visibility, export,
  print, and loading/empty/error states.
- Universal filter engine backed by the URL, so drill-down preserves context.
- Landing page and branded sign-in.
- Responsive to tablet widths; accessible names and keyboard focus throughout.

### Added — Operations

- `db:doctor` — connectivity, volumes and integrity invariants in one command.
- `db:restore` — offline recovery when the database will not open.
- `db:reset` — rebuild, including from a damaged data directory.
- Heartbeat directory lock preventing concurrent opens, with graceful wait on restart.
- Actionable diagnosis when an embedded database is damaged by a force-kill.

### Fixed — during the build

Twelve defects found by testing rather than inspection. Full detail in
`04_KNOWN_ISSUES.md § RESOLVED`. The most significant:

- Dashboard PO value disagreed with the PO list total by the value of cancelled
  orders; the list now uses the same definition as the metric catalogue.
- Session did not survive a page reload — two concurrent refresh calls raced against
  refresh-token rotation.
- An expired session tripped the sign-in rate limiter and locked users out of signing
  in; auth routes now have separate budgets.
- Backup restore failed on `jsonb` columns holding JSON strings; restore logic is now
  shared between the API and CLI so they cannot diverge.
- Sidebar forced horizontal scrolling at tablet width.

### Security advisories addressed

- Upgraded `googleapis` and `vitest`, pinned a patched `uuid`; **0 vulnerabilities**.
- Upgraded React Router to v7 for CVE-2025-68470 (open redirect).

### Known limitations

Recorded honestly in `04_KNOWN_ISSUES.md`. The one capability not runtime-verified is
the authenticated Google Sheets read, because no service-account credential existed in
the build environment.
