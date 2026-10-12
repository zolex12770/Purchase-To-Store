# 02 — Implementation Status

Status vocabulary (SRS §33): `NOT_STARTED` · `IN_PROGRESS` · `BLOCKED` ·
`IMPLEMENTED` (code exists) · `TESTED` (automated tests pass) · `VERIFIED` (runtime
behaviour observed end to end).

**A feature is only VERIFIED when it was actually exercised** — through the API,
through a browser, or both.

---

## Summary

| Phase | Area | Status |
|---|---|---|
| 0 | Forensic audit | ✅ VERIFIED |
| 1 | Architecture & ADRs | ✅ VERIFIED |
| 2 | Database, migrations, seed | ✅ VERIFIED |
| 3 | Backend foundation, auth, RBAC | ✅ VERIFIED |
| 4 | Frontend foundation, design system, shell | ✅ VERIFIED |
| 5 | Authentication & authorisation | ✅ VERIFIED |
| 6 | Master data | ✅ VERIFIED |
| 7 | Purchase Indent & approval | ✅ VERIFIED |
| 8 | Purchase Order (4 modes) | ✅ VERIFIED |
| 9 | GRN | ✅ VERIFIED |
| 10 | Management Analysis | ✅ VERIFIED |
| 11 | Google Sheets sync | ⚠️ TESTED (unconfigured path) — see K-03 |
| 12 | Admin, import/export, backup, audit | ✅ VERIFIED |
| 13 | Hardening | ✅ VERIFIED |
| 14 | Full E2E testing | ✅ VERIFIED |
| 15 | Release audit | ✅ VERIFIED |
| 16 | Production hardening (v1.1) | ✅ VERIFIED |

**309 automated checks pass.** Both projects typecheck, build, and report 0 npm
vulnerabilities.

---

## Phase 16 — Production hardening (v1.1)

| Feature | Status | Evidence |
|---|---|---|
| Design system v2 (9 ramps, 6 module identities, 13 animations) | VERIFIED | Browser, both themes, 9 viewports |
| Dark / light / follow-system theming | VERIFIED | No flash on load; toggle persisted |
| KPI count-up, gradient medallions, trend pills | VERIFIED | Screenshots; reduced-motion honoured |
| Landing and login transformation | VERIFIED | Screenshots, both themes |
| **Data classification (`seed_tag`, migration 006)** | VERIFIED | 249 demo rows classified, **0 UNKNOWN** |
| **`db:purify` — backup → purge → verify** | VERIFIED | 888 rows deleted; 16/16 assertions |
| **Purification durable across restart** | VERIFIED | Purged, restarted, confirmed still empty |
| `db:reset -- --clean` (empty production database) | VERIFIED | Delivered state |
| `db:backup` CLI | IMPLEMENTED | Shares the collector with the API |
| `migrate -- --check` | IMPLEMENTED | Reports pending and edited migrations |
| **Load testing** | VERIFIED | Measured at concurrency 1 and 6 |
| Deployment package (compose, Dockerfiles, nginx, 4 scripts) | IMPLEMENTED | Written and syntax-checked; **not built** — Docker daemon unavailable |
| Google Sheets production guide | VERIFIED | All 9 tabs documented |
| Security re-audit | VERIFIED | 14 areas; 1 issue found and fixed |

### What "not verified" still means here

Two things, both stated rather than rounded up:

1. **Google Sheets authenticated read** — no service-account credential exists in
   this environment.
2. **Container images** — written and reviewed, but the Docker daemon is not
   running on this host, so they were never built or started.

Everything else in this phase was executed.

---

## Detail

### Master data — VERIFIED

| Feature | Status | Evidence |
|---|---|---|
| Supplier Master CRUD | VERIFIED | E2E + browser; delete degrades to deactivate when referenced |
| Item Master CRUD | VERIFIED | E2E + browser; cascading Main → Sub Group |
| Supporting masters (10 categories) | VERIFIED | One table, one CRUD, one screen (ADR-014) |
| **Item auto-population** | VERIFIED | `/items/:id/profile` returns description, type, department, cost centre, groups, HSN, UOM, specification, rate **and live balances** |
| **Supplier auto-population** | VERIFIED | `/suppliers/:id/profile` fills PO commercial terms |
| Master-driven dropdowns | VERIFIED | `/lookups/options`; no business value is hard-coded in the frontend |
| Supplier purchase history | VERIFIED | Drawer shows POs, top items, totals |
| Item rate history & trend | VERIFIED | Drawer shows rate chart, suppliers, open demand |

### Purchase Indent — VERIFIED

| Feature | Status | Evidence |
|---|---|---|
| Header/detail form | VERIFIED | Browser; item selection auto-fills the line |
| Server-issued numbering | VERIFIED | `IND-YYYYMMDD-####`; 8 concurrent creations → 8 unique numbers |
| Draft / submit / approve / reject | VERIFIED | Integration + E2E |
| Rejection reason mandatory | VERIFIED | Refused without one; persisted and displayed |
| **Self-approval blocked** | VERIFIED | Integration test |
| Approved indent protected from edit | VERIFIED | Integration test |
| Live & pending quantities | VERIFIED | Derived from `v_indent_line_balance` |
| Approval history timeline | VERIFIED | Browser |
| Analysis view | VERIFIED | Browser |

### Purchase Order — VERIFIED

| Feature | Status | Evidence |
|---|---|---|
| **Direct PO** | VERIFIED | E2E + integration |
| **Indent-based PO** | VERIFIED | E2E + integration |
| **Multi-indent consolidation** | VERIFIED | One PO line, two sources, both indents auto-closed |
| **Supplier-wise consolidation** | VERIFIED | `eligible-lines?matchSupplier=true` |
| Source traceability per line | VERIFIED | `po_indent_sources`; visible and clickable on the document |
| Quantity control | VERIFIED | Over-ordering refused with the arithmetic explained |
| Sources must reconcile with PO qty | VERIFIED | Integration test |
| **Concurrency safety** | VERIFIED | Two simultaneous POs for 70 of 100 → exactly one succeeds |
| Generated final rate & amount | VERIFIED | Database-computed; asserted through the API |
| Pending / Complete views | VERIFIED | Defined by balance, not by a status string |
| Issue / cancel / short-close | VERIFIED | With mandatory reasons; cancel releases indent quantity |
| Analysis view | VERIFIED | Browser |

### GRN — VERIFIED

| Feature | Status | Evidence |
|---|---|---|
| PO-driven receipt | VERIFIED | Receivable POs and outstanding balances load |
| Partial receipt | VERIFIED | PO → `PARTIALLY_RECEIVED`, balances correct |
| Final receipt | VERIFIED | PO → `COMPLETED`, pending → 0 |
| Over-receipt prevented | VERIFIED | Refused with the arithmetic explained |
| **Concurrency safety** | VERIFIED | Two simultaneous receipts cannot exceed ordered qty |
| Draft vs posted | VERIFIED | A draft moves nothing; posting re-validates against the live balance |
| Cancellation reverses balance | VERIFIED | Quantity returned, PO status recomputed |
| Own GRN number (ADR-008) | VERIFIED | `GRN-YYYYMMDD-####` |

### Management Analysis — VERIFIED

| Feature | Status | Evidence |
|---|---|---|
| 24 KPIs from one catalogue | VERIFIED | Each carries formula, source, unit, drill-down |
| **Dashboard reconciles with lists** | VERIFIED | Asserted in integration + E2E |
| Trends (day/week/month/quarter/year) | VERIFIED | Browser |
| 9 breakdown dimensions | VERIFIED | All exercised |
| Ageing buckets (PO and indent) | VERIFIED | Browser |
| Supplier performance | VERIFIED | Fulfilment and on-time rates |
| Exception analysis | VERIFIED | 8 exception types incl. a status-drift integrity alarm |
| **Clickable everything** | VERIFIED | KPI cards, chart bars, donut slices, table rows |
| Drill-down preserves filters | VERIFIED | Browser; filters live in the URL |
| Data freshness & filter context | VERIFIED | `meta.generatedAt`, `meta.filters` |

### Admin & operations — VERIFIED

| Feature | Status | Evidence |
|---|---|---|
| User management | VERIFIED | CRUD, roles, reset, unlock, deactivate |
| Last-Super-Admin protection | VERIFIED | Cannot remove or deactivate the last one |
| Role & permission management | VERIFIED | 64 permissions grouped by module |
| **RBAC enforced server-side** | VERIFIED | Store User refused 5 admin operations |
| Audit log + before/after diff | VERIFIED | Browser; faceted filtering |
| Excel / CSV export | VERIFIED | Filter-aware, branded, timestamped |
| Import preview → validate → commit | VERIFIED | Strict and partial modes, error report |
| Backup create / verify / restore | VERIFIED | Checksum-verified; **restore exercised on a genuinely corrupted database** |
| Settings | VERIFIED | Browser |
| Print layouts | IMPLEMENTED | Print CSS and branded header render; no physical print produced |

### Google Sheets sync — TESTED (partial)

| Feature | Status | Evidence |
|---|---|---|
| ON/OFF header toggle | VERIFIED | Persisted in `app_settings`, survives restart |
| Sheet → entity mappings (9 sheets) | VERIFIED | Seeded and displayed |
| **`Cost Center` header alias (ADR-006)** | VERIFIED | Both spellings accepted as data, not a special case |
| Degrades cleanly without credentials | VERIFIED | 502 with a clear reason; server stays healthy |
| Job history & conflict log | IMPLEMENTED | Schema, API and UI complete |
| Masters-first sync order | IMPLEMENTED | `sync_order` on every mapping |
| Transactional sheets reconciled, never written | IMPLEMENTED | By design (K-06) |
| **Authenticated read against the live sheet** | ⚠️ **NOT VERIFIED** | No credential available — see K-03 |

---

## What "not verified" means here

Exactly one capability is not runtime-verified: reading the actual Google spreadsheet,
because no service-account credential exists in this environment. Everything around it
— mappings, aliases, toggle, scheduler, conflict recording, job history, and graceful
degradation — is implemented and tested.

To validate it: set `GOOGLE_SERVICE_ACCOUNT_KEY_FILE`, share the sheet with the
service account, and use **Dry run** first.
