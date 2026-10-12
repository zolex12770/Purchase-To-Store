# 05 — Test Status

**Last run:** 25 August 2026 · all suites green

| Suite | Tests | Result | How to run |
|---|---:|---|---|
| Backend unit — financial calculations | 21 | ✅ 21/21 | `cd backend && npm test` |
| Backend unit — state machines | 20 | ✅ 20/20 | `cd backend && npm test` |
| Backend integration — workflow, RBAC, integrity | 39 | ✅ 39/39 | `cd backend && npm test` |
| **Backend total** | **80** | **✅ 80/80** | |
| End-to-end API (live server, 15 sections) | 131 | ✅ 131/131 | scratchpad harness |
| Browser UI (real Chromium, 24 screens) | 98 | ✅ 98/98 | scratchpad harness |
| **Grand total** | **309** | **✅ 309/309** | |

Type checking passes cleanly on both projects, both build for production, and
`npm audit` reports **0 vulnerabilities** on each.

---

## 1. Unit tests

### `src/domain/money.test.ts` — 21 tests

Asserts the property that matters: **money arithmetic is exact**.

- Sums and products that IEEE-754 gets wrong (`0.1 + 0.2`, `1.1 × 3`) are exact here
- `finalRate` and `lineAmount` mirror the database's generated columns, including
  fractional discounts and half-up rounding at four and two decimal places
- Enterprise-scale values (`999,999 × 18,650.75`) stay precise
- Spreadsheet cell parsing: currency symbols, thousands separators, `(500)` negatives,
  and **rejecting** `N/A`/blank rather than silently reading zero
- Indian digit grouping (`12,34,567.89`)

### `src/domain/status.test.ts` — 20 tests

Pins down every legal document transition, so a change is a deliberate business
decision rather than an accident.

- Indent, PO and GRN happy paths
- Approval straight from draft is refused; a cancelled document cannot be revived
- A completed PO **can** fall back to partially received when a receipt is cancelled
- A PO with receipts cannot be cancelled — short close instead
- Edit locks: an indent leaving draft, an issued PO, a posted GRN
- Every declared status has a presentation tone

---

## 2. Integration tests — `src/tests/workflow.test.ts` (39 tests)

Runs against a **real test database** (`NODE_ENV=test`, separate directory) with the
real schema, generated columns, balance views and transaction boundaries. Nothing is
mocked.

| Area | What is proven |
|---|---|
| Document numbering | Sequential, correctly formatted, and **8 concurrent creations produce 8 unique numbers** |
| Generated columns | `final_rate`/`amount` computed by the database; fractional discounts exact; discount > 100 refused |
| Indent → PO control | Eligible quantity reduces by exactly what was ordered; over-ordering refused with the arithmetic explained; sources must reconcile with PO quantity; an unapproved indent cannot be drawn on |
| **Concurrency** | **Two simultaneous POs for 70 of 100 available: exactly one succeeds (201/422), and `ordered_qty ≤ indent_qty` always holds** |
| Consolidation | Two indents merge into one PO line with two sources; both source indents auto-close; cancelling releases the reserved quantity and reopens them |
| GRN | Partial → final receipt drives `PARTIALLY_RECEIVED` → `COMPLETED`; over-receipt refused; receipt against a draft PO refused; **two simultaneous receipts cannot exceed the ordered quantity**; cancelling a posted GRN returns the quantity and recomputes status |
| Approval workflow | Self-approval blocked; rejection without a reason refused and the reason persisted; an approved indent cannot be edited |
| RBAC | A Store User can do store work and is refused users, roles, audit, indent creation and backup — **all 403 from the server** |
| Security | Unauthenticated 401; forged token 401; wrong password and unknown user return the *same* message |
| Input hardening | SQL injection parameterised safely and the table survives; malicious `sortBy` falls back to the allow-list; unknown analytics dimension 422; invalid body returns field-level issues |
| Analytics | Dashboard PO value reconciles with the PO list total; every KPI publishes formula, source and drill-down; **zero PO status drift** |
| Data integrity | Eight invariants asserted across everything the suite created |
| Audit | Full indent lifecycle recorded; failed sign-ins audited **without storing the attempted password** |

### The integrity invariants

Asserted at the end of the suite, over all data it generated:

```
no indent line over-ordered              no PO line over-received
no negative pending quantities (either)  stored PO status == derived status
generated money columns consistent       every rejected indent has a reason
every PO source points at an approved indent
PO value reconciles as received + pending
```

---

## 3. End-to-end API tests — 131 checks

Drives the **running server** over HTTP across 15 sections: authentication and the
forced-rotation gate, master auto-population, the full indent → approval → PO → GRN
workflow, multi-indent consolidation, direct PO, partial and complete receipt, GRN
cancellation, analytics reconciliation, all nine breakdown dimensions, filters,
global search, Excel and CSV export, RBAC as three different roles, input hardening,
audit trail, backup creation and checksum verification, and Google sync degradation.

Notable assertions:

- Bootstrap credentials are gated: business routes return **403** until the password
  is rotated
- Generated columns verified through the API: `100 − 10% = 90`, `60 × 90 = 5,400`
- Export produces a real XLSX (PK header, > 2 KB) carrying Zolex branding and filter
  context
- Backups are written **outside** the project folder, and the path is asserted
- Sync without credentials fails with 502 and the server stays healthy

---

## 4. Browser UI tests — 98 checks

A real Chromium walks all 24 screens. Every screen must render with **zero console
errors, zero page errors, zero failed requests and no horizontal overflow**.

| Group | Checks |
|---|---|
| Public | Landing, Login |
| Authentication | Sign-in, shell renders |
| Management Analysis | Renders, ≥ 10 panels, ≥ 2 charts |
| Masters | Supplier, Item, Supporting Masters — each with data rows |
| Transactions | Indent list/analysis/form, PO list/pending/complete/analysis/form, GRN list/analysis/form |
| Admin | Users, Roles, Audit, Backup, Import/Export, Sync, Settings, Profile |
| Drill-down | Row click opens the document; PO shows lines and source traceability; indent shows approval history; URL filters are applied and visible |
| Global search | Grouped results, no errors |
| Responsive | 1024 px and 820 px — no overflow |
| Accessibility | Every interactive control has an accessible name; controls are keyboard focusable |

Screenshots of every screen were captured and reviewed; two layout defects found that
way (R-07, R-08 in [04_KNOWN_ISSUES.md](04_KNOWN_ISSUES.md)) were fixed.

---

## 5. Load / latency measurement (v1.1)

Measured against the running API with `scratchpad/loadtest/load.mjs`. Every
figure is an actual HTTP round trip — nothing here is extrapolated.

**Host:** 4 logical cores, 6 GB RAM, embedded PGlite, dev build.

### Single user (concurrency 1, 12 samples per endpoint)

| Endpoint | min | p50 | p99 |
|---|---:|---:|---:|
| Health (incl. DB ping) | 4 ms | 6 ms | 13 ms |
| Lookup options | 10 ms | 11 ms | 12 ms |
| Analytics — ageing / trends / breakdown | 8–13 ms | 15–16 ms | 18–28 ms |
| GRN list | 15 ms | 17 ms | 21 ms |
| Supplier search | 17 ms | 18 ms | 22 ms |
| Audit log | 13 ms | 15 ms | 24 ms |
| Dashboard KPIs | 32 ms | 34 ms | 43 ms |
| Item search / list | 35–39 ms | 44–46 ms | 49–52 ms |
| Analytics — exceptions | 49 ms | 57 ms | 81 ms |
| PO list | 48 ms | 59 ms | 77 ms |
| Indent list | 62 ms | 89 ms | 117 ms |
| **Authentication** | 411 ms | 753 ms | 3925 ms |

Every read is under 120 ms. Authentication is dominated by bcrypt at cost 12 —
the intended cost of a slow KDF, not a defect.

### Six concurrent users

| Measure | Result |
|---|---|
| Sustained mixed workload (30 s) | **217 ms p50 · 443 ms p99 · 21.3 req/s** |
| Genuine errors | **0** |
| Correctly rate-limited (HTTP 429) | 3,033 |
| Slowest endpoint | Item search — 363 ms p50, 2180 ms p99 |

### What the numbers mean

Latency multiplies under concurrency because **PGlite is single-writer and
serialises every query**. That is a property of the embedded development driver,
not of the application — the same SQL against a real PostgreSQL server runs in
parallel across pooled connections.

This is the measured evidence behind ADR-001 and behind the requirement that
production sets `DB_DRIVER=pg`.

> A cautionary measurement worth recording. An early run showed item search at
> **5,148 ms p50**. It was not a slow query: the host was at 100% CPU with 0.1 GB
> of RAM free and eight concurrent requests were queueing behind a single-threaded
> engine. The same endpoint, same code, measured serially: **44 ms**. A latency
> number without its machine state is not a measurement.

**Not covered:** the production topology. Re-run this against the deployed stack
after go-live.

---

## 6. Defects found by testing

Testing did its job — it found real bugs rather than confirming assumptions. Twelve
defects were found and fixed, including a dashboard/list reconciliation mismatch, a
session-restore race against refresh-token rotation, a rate-limiter cascade that
locked users out of signing in, and a backup restore that failed on `jsonb` columns.
All are recorded with root cause and fix in
[04_KNOWN_ISSUES.md § RESOLVED](04_KNOWN_ISSUES.md#resolved-during-this-build).

---

## 7. Not covered

Stated plainly:

- **Google Sheets authenticated read path** — no service-account credential was
  available in this environment (K-03). The unconfigured path is tested.
- **Load/performance at scale** — the design follows SRS §30 (server-side pagination,
  indexed dimensions, aggregate SQL, no N+1) and is responsive on the demo dataset,
  but has not been benchmarked against hundreds of thousands of rows.
- **Cross-browser** — verified in Chromium. No Firefox/Safari/Edge matrix was run.
- **Print output** — print styles are implemented and a branded print header renders,
  but no physical print was produced.
- **Import commit against very large files** — the 20,000-row cap is enforced;
  behaviour at the cap was not benchmarked.

---

## 8. Running the tests

```bash
cd backend
npm test              # 80 unit + integration tests
npm run typecheck
npm run db:doctor     # integrity invariants against the live database

cd ../frontend
npm run typecheck
npm run build
```
