# 01 — Architecture Decision Records

Each ADR records a decision, the forces behind it, and its consequences. ADR-002 … ADR-011 resolve
the ten "open decisions to confirm during implementation" listed in **SRS §44**.

---

## ADR-001 — SQL engine: PostgreSQL dialect with a dual-driver data layer

**Status:** Accepted · **Phase:** 1 · **Resolves:** SRS §19, §26, §44 (SQL engine/version)

### Context

Two SRS requirements pull against each other on this host:

- **§19 / §44** — SQL is the primary system of record; PostgreSQL recommended; the database must
  live **outside the project source folder**.
- **§26 / §29** — the product must start from exactly `npm install && npm run dev` in `backend/`
  and `frontend/`, with no undocumented manual steps.

The audit found **no PostgreSQL server and no running Docker daemon** on the host. Requiring the
user to install and configure a database server before the app runs would fail §29.

### Decision

Adopt **PostgreSQL as the one and only SQL dialect**, and access it through a single thin driver
adapter (`backend/src/db/driver.ts`) with two interchangeable backends:

| Backend | When | Engine |
|---|---|---|
| **`pglite`** (default) | `DB_DRIVER=pglite` — development, evaluation, single-node deployment | `@electric-sql/pglite` — real PostgreSQL 18.3 compiled to WASM, persisting to a directory |
| **`pg`** | `DB_DRIVER=pg` + `DATABASE_URL` — production / multi-node | `node-postgres` pool against a real PostgreSQL server |

Both backends execute **the same SQL text and the same migration files**. The adapter exposes only
`query()`, `transaction()` and `close()`. No business logic, no dialect branching, no ORM.

### Why not the alternatives

- **Require a PostgreSQL server** — violates §29 on this host.
- **Require Docker** — daemon is not running; adds an unverifiable dependency.
- **SQLite** — cannot satisfy the specification: no exact `NUMERIC` (money would ride on
  floating-point REAL, breaching the financial-precision requirement) and no genuine row-level
  locking for the concurrent quantity controls of §11.3 / §12.
- **An ORM (Prisma/TypeORM)** — hides the aggregate SQL the dashboards need, encourages N+1
  (§30 forbids), and adds a native/engine dependency.

### Consequences

- ✅ Real Postgres semantics were **measured, not assumed** (see `00_PROJECT_AUDIT.md` §4): exact
  `NUMERIC`, FK enforcement, transaction rollback, CTEs, window functions, `SELECT … FOR UPDATE`.
- ✅ `npm run dev` works on a clean machine with zero external setup.
- ✅ Database, backups and uploads live in `%ZOLEX_DATA_ROOT%` (default
  `C:\Users\<user>\ZolexERP`) — **outside the repository**.
- ✅ Migrating to a production PostgreSQL server is a two-line `.env` change; the SQL is portable
  as written.
- ⚠️ `pglite` is in-process and single-writer. This is correct for one backend process (the backend
  is the single writer and serialises transactions), but horizontal scaling requires switching to
  `DB_DRIVER=pg`. Documented in `09_DEPLOYMENT.md`.

---

## ADR-002 — Document numbering format

**Resolves:** SRS §44 (document numbering format for Indent, PO, GRN) · **Also:** §10

**Decision.** Numbers are issued **server-side only**, never by the frontend, from a
`document_sequences` table mutated inside the caller's transaction with `FOR UPDATE`:

| Document | Format | Example |
|---|---|---|
| Purchase Indent | `IND-YYYYMMDD-####` | `IND-20260824-0007` |
| Purchase Order | `PO-YYYYMMDD-####` | `PO-20260824-0003` |
| GRN | `GRN-YYYYMMDD-####` | `GRN-20260824-0011` |

The counter resets per document type per day; the prefix and padding are configurable rows in
`document_sequences`, not constants in code. Uniqueness is additionally guaranteed by a `UNIQUE`
constraint on the document number, so a race can never mint a duplicate — it fails and retries.

**Rejected:** frontend timestamp/UUID identifiers (fragile, non-sequential, unauditable — SRS §41
explicitly warns against fragile frontend timestamps).

---

## ADR-003 — PO completion definition

**Resolves:** SRS §44 (exact PO completion definition) · **Also:** §11.4

**Decision.** A PO line is **COMPLETED** when `received_qty >= po_qty`. A PO header is:

| Status | Rule |
|---|---|
| `DRAFT` | not yet issued |
| `OPEN` | issued, `received_qty = 0` across all lines |
| `PARTIALLY_RECEIVED` | some line has `0 < received_qty < po_qty` |
| `COMPLETED` | **every** line satisfies `received_qty >= po_qty` |
| `SHORT_CLOSED` | manually closed with a reason while quantity remains outstanding |
| `CANCELLED` | cancelled before any receipt |

Status is **derived from receipts**, recomputed transactionally after every GRN post — it is never
a free-text field a user can set. `SHORT_CLOSED` exists because real procurement must close a PO
that will never be fully delivered; it requires the `approve` permission and a mandatory reason,
and it releases the outstanding quantity from "pending" analytics.

---

## ADR-004 — Financial precision

**Resolves:** financial-precision requirement · **Also:** SRS §20

**Decision.**

- Quantities: `NUMERIC(18,4)` · Rates: `NUMERIC(18,4)` · Discount %: `NUMERIC(9,4)` ·
  Amounts: `NUMERIC(18,2)`
- `final_rate` and `amount` are **`GENERATED ALWAYS AS … STORED`** columns computed by PostgreSQL:
  `final_rate = round(rate * (1 - discount_pct/100), 4)`, `amount = round(po_qty * final_rate, 2)`.
  They therefore **cannot drift from the inputs** and cannot be forged by a client.
- Server-side JS money math (aggregation, import parsing) uses `decimal.js`. `Number` is never used
  to persist a monetary value.
- The `pg` driver is configured to return `NUMERIC` as **string**, not JS `number`, so no value
  passes through a float on the way out of the database.

---

## ADR-005 — Quantity control and concurrency

**Resolves:** SRS §11.3, §12, §20, §56 · **Risk:** R-03

**Decision.** Balances are **derived, never stored in mutable counters**:

```
indent_line.pending_qty  = indent_qty − Σ(po_indent_source.consumed_qty for that indent line)
po_line.pending_grn_qty  = po_qty     − Σ(grn_line.grn_qty for that PO line, posted only)
```

Both are exposed as SQL views (`v_indent_line_balance`, `v_po_line_balance`) so that **operational
screens, validation and analytics all read the same definition** (SRS §34, §38 — "analytics must
use the same authoritative transaction definitions as operational screens").

Every mutation that consumes a balance runs in **one transaction** that:
1. `SELECT … FOR UPDATE` locks the source indent line / PO line,
2. re-reads the balance from the view **inside the lock**,
3. rejects the operation if the requested quantity exceeds it,
4. writes the document, its lines, its source references and its audit record,
5. recomputes and persists the derived document status.

Any failure rolls the whole thing back. A partially committed document is therefore impossible.
Database `CHECK` constraints (`qty > 0`, `discount_pct BETWEEN 0 AND 100`) act as the last line of
defence beneath the service layer.

---

## ADR-006 — `Cost Center` sheet column mapping

**Resolves:** SRS §9, §44 (is the Cost Center column really named 'Indent Type'?)

**Decision.** Treat it as a **source-data header typo**, and do not hard-code around it. The sync
layer defines each sheet's mapping declaratively with **header aliases**:

```ts
{ sheet: 'Cost Center', target: 'cost_centres',
  columns: [{ field: 'name', headers: ['Cost Center', 'Cost Centre', 'Indent Type'] }] }
```

The first header present in the sheet wins. If the sheet is corrected upstream, nothing in the code
changes. The alias list is data in `google_sheet_mappings`, editable by an administrator, so a
future header change needs no deployment.

---

## ADR-007 — Google Sheets synchronisation strategy

**Resolves:** SRS §8, §44 (sync frequency / service-account ownership)

**Decision.**

- **Direction:** one-way, **Sheets → SQL**, and **masters-first**. SQL is the system of record
  (§8). Writing back to the sheet is deliberately not implemented: it would let a spreadsheet edit
  mutate an approved ERP transaction, which §8 forbids.
- **Trigger:** manual "Sync now" plus an optional interval poll (`GOOGLE_SYNC_INTERVAL_MINUTES`)
  armed only while the header toggle is **ON**. The toggle is persisted in `app_settings`, so it
  survives restart and is global, not per-browser.
- **Protection:** the sync engine **never mutates a transactional document that has left DRAFT**.
  A sheet row conflicting with an approved indent / issued PO / posted GRN is written to
  `google_sync_errors` with both values and surfaced to administrators — never auto-resolved.
- **Credentials:** a service account JSON path supplied via `GOOGLE_SERVICE_ACCOUNT_KEY_FILE`,
  stored **outside the repository**, or an API key for public read-only sheets. Absent
  credentials degrade to a clear "not configured" state — they never crash the server.
- **Auditability:** every run writes a `google_sync_jobs` row (status, timings, rows read /
  inserted / updated / skipped / rejected) plus an `audit_logs` entry.

---

## ADR-008 — GRN identity

**Resolves:** SRS §44 (does GRN need its own number?)

**Decision.** **Yes.** The supplied sheet keys GRN rows only by PO No + Item Code, which cannot
represent two partial receipts of the same item on different dates, and gives the receipt no
auditable identity. The ERP issues `GRN-YYYYMMDD-####` (ADR-002) and models GRN as
header + lines, each line referencing its `po_line_id`. Sheet rows are ingested as *lines* and
grouped into a header per (PO, date).

---

## ADR-009 — Analytics governance: one metric catalogue

**Resolves:** SRS §13, §38 · **Risk:** R-05

**Decision.** Every KPI is declared once in `backend/src/domain/metrics.ts` with `key`, `label`,
`description`, `formula`, `unit`, `source` and `drilldown` target. Dashboards may only render
metrics from this catalogue, and the catalogue is served to the frontend at
`GET /api/v1/analytics/metrics` so a KPI card's tooltip shows its **authoritative definition**.
Analytics SQL reads the same balance views as the operational screens (ADR-005), which is what
makes dashboard figures reconcile with transaction lists by construction rather than by luck.

---

## ADR-010 — Supplier identity

**Resolves:** SRS §44 (does Supplier Master need a supplier code?)

**Decision.** **Yes** — add `supplier_code`, auto-generated (`SUP-####`) when not supplied. The
sheet keys suppliers by name alone, but supplier names are edited (spelling, suffixes like "Pvt
Ltd") and a renamed supplier would orphan its purchase history. `supplier_code` is the stable
foreign key; `supplier_name` carries a `UNIQUE` constraint for import matching and remains the
searchable label. Same reasoning applies to `Item Code`, which the SRS already specifies as the
unique searchable identifier.

---

## ADR-011 — Approval hierarchy, currency/tax, and backup retention

**Resolves:** the remaining SRS §44 items.

- **Approval hierarchy (§5, §10).** Single-level: an indent in `PENDING_APPROVAL` is actioned by
  any user holding the `indent.approve` permission (the **Purchase Head** role by default). The
  approval record is a row in `indent_approvals` with `level`, so a multi-level chain can be added
  later without a schema migration. **A user may not approve their own indent** — enforced
  server-side.
- **Currency & tax.** Currency is carried on the supplier and stamped onto the PO header
  (`INR` default, from `app_settings`). **Tax/GST is deliberately out of scope**: SRS §3.2 excludes
  accounting/GL, and §11.2 defines the PO line as Rate → Discount % → Final Rate → Amount with no
  tax field. `HSN Code` is captured on the item for reporting only. Introducing a tax engine would
  be scope invention.
- **Backup retention.** Backups are written to `%ZOLEX_DATA_ROOT%/backups` (outside the repo,
  ADR-001) as timestamped JSON dumps with a SHA-256 checksum and a `backup_metadata` row. Default
  retention **30 days / 50 backups**, whichever is larger, configurable via `app_settings`.
  Restore requires the `admin` permission, is transactional, and is audited.

---

## ADR-012 — Frontend architecture

**Status:** Accepted · **Phase:** 1 · **Resolves:** SRS §15, §16, §36

**Decision.** React 18 + TypeScript + Vite; React Router v6; **TanStack Query** for all server
state (dedupes requests, caches, and gives every table server-side pagination for free — SRS §30);
**Recharts** for charts; **lucide-react** for iconography.

**No component library** (no Bootstrap, MUI, Ant). The SRS demands a *bespoke premium enterprise
visual language* (§15) and explicitly warns against a generic CRUD look. The design system is a
hand-built token layer (`styles/tokens.css`) plus primitives in `components/ui/`. This keeps full
control of gradients, elevation, density and motion, and avoids shipping a megabyte of unused CSS.

State that belongs in the URL (filters, pagination, drill-down context) lives in the URL —
satisfying §14's "drill-down must preserve applied filters and source context" and making every
analytical view shareable and back-button-correct.

---

## ADR-013 — Authentication

**Status:** Accepted · **Resolves:** SRS §6, §25

**Decision.** JWT access token (short-lived, 8h default) + refresh token stored as an
`httpOnly`, `sameSite=strict` cookie and persisted hashed in `user_sessions` so it can be revoked
server-side on logout. Passwords hashed with **bcryptjs** (pure JS — no node-gyp on Windows, R-08),
cost 12. Failed logins are counted and the account locks for 15 minutes after 5 consecutive
failures (§6 "failed-login protection"). Every login, failed login, logout and token refresh is
audited.

The bootstrap administrators (Employee IDs **10221** and **10422**) have no default password: a new
database gives them `BOOTSTRAP_ADMIN_PASSWORD` (12+ characters) or a random password written once
to `bootstrap-admin-password.txt` in the data root, never to the log (`seed.ts`
`bootstrapPassword()`). They are seeded with `must_change_password = true`, and until the password is
changed the API answers only `/auth/me`, change-password, refresh and logout — every other route
returns 403 `PASSWORD_CHANGE_REQUIRED` (§6, §25, R-07).

---

## ADR-014 — Supporting masters share one table

**Status:** Accepted · **Phase:** 2 · **Resolves:** SRS §7.3, §19

### Context

The SRS requires master-driven dropdowns for PO Type, Indent Type, Cost Centre,
Department, Item Type, Main Group, Sub Main Group and UOM, and §19 names PO Types,
Indent Types and Cost Centres as entities. Currency and payment terms are needed too.
That is ten small master lists with identical shape: code, name, description, sort
order, active flag, audit columns.

### Decision

One `lookups` table with a `category` discriminator, plus `parent_id` for hierarchy.

- Ten near-identical tables would mean ten migrations, ten services, ten route files
  and ten admin screens — the duplicate-implementation trap the brief forbids (§54).
- `parent_id` gives **Sub Main Group → Main Group** its cascade, which the Item Master
  form uses to filter sub-groups by the chosen group.
- Uniqueness is per category: `UNIQUE (category, upper(code)) WHERE deleted_at IS NULL`,
  so two categories may reuse a code without colliding.
- A `CHECK` constraint pins the category set, so a typo cannot invent a master.
- `is_system` marks values that ship with the product (units, currencies, payment
  terms) and protects them from deletion.

The entities the SRS names still exist and are still master-driven — they are simply
rows partitioned by category rather than separate tables.

### Consequences

- ✅ One CRUD service, one API shape, one admin screen for every dropdown source.
- ✅ `GET /lookups/options` returns every dropdown in the product in a single request,
  which the frontend caches — no screen hard-codes a business value (§53), and no form
  makes ten round-trips.
- ✅ Adding a new master category is one line in a `CHECK` constraint and one entry in
  a label map.
- ⚠️ Foreign keys from `items`, indents, POs and GRNs all point at the same table, so
  the column name carries the meaning (`department_id`, `cost_centre_id`). Accepted:
  the alternative is ten tables of three columns each.
- ⚠️ A category-specific field would need `extra` (jsonb) rather than a typed column.
  None is required today; if one category grows genuinely distinct attributes, it can
  be promoted to its own table without disturbing the others.
