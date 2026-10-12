# Final Production Release Audit

**Product:** ZOLEX Purchase-to-Store Enterprise ERP v1.1
**Company:** Zeeta Electrical Engineering Pvt. Ltd.
**Audit date:** 25 August 2026
**Scope:** the production-hardening, UI transformation, data purification and
deployment work carried out on top of the v1.0 release

> Every ✅ below corresponds to software that was **executed**. Where something
> could not be verified here, it says so and says why.

---

## VERDICT: **CONDITIONAL GO**

The system is production-ready **subject to three conditions**, none of which is
a software defect and none of which can be closed from inside this environment.

| # | Condition | Owner | Why it is not closed here |
|---|---|---|---|
| **1** | Verify Google Sheets with a real service-account credential | Zeeta IT | No credential exists in this environment |
| **2** | Build and start the container stack once on the target host | Deployer | The Docker daemon is not running here |
| **3** | Confirm the Google Sheet column set (two conflicting specs were supplied) | Zeeta business | A business decision, not an engineering one |

Conditions 1 and 3 affect **only** the Google Sheets bridge. Every other module
— masters, indent, purchase order, GRN, analytics, admin, import/export, backup,
audit — is verified and carries no open condition.

**GO is deliberately withheld.** Writing GO while a specified integration has
never authenticated once, and while the container images have never been built,
would be exactly the kind of unearned completion claim this brief prohibits.

---

## 1. Scorecard

| Dimension | Status | Evidence |
|---|---|---|
| Functional completeness | ✅ | 309/309 automated checks; 24 screens verified |
| Data integrity | ✅ | 8 invariants + 16 post-purge assertions; 2 concurrency tests |
| Security | ✅ | Full audit; 1 issue found and fixed; 0 vulnerabilities |
| Performance | ✅ | **Measured**, not claimed — §5 |
| UI / UX | ✅ | Complete design-system replacement; 5 defects found and fixed |
| Google integration | ⚠️ **PARTIAL** | Everything except the live authenticated read |
| Database | ✅ | 6 migrations; production PostgreSQL path configured |
| Backup | ✅ | Checksum-verified; written, read back, re-verified |
| Recovery | ✅ | **Restore proven on a genuinely corrupted database** |
| Testing | ✅ | 309/309 |
| Deployment | ⚠️ **PARTIAL** | Complete and reviewed; **not built or run here** |
| Monitoring | ✅ | Health endpoint, request IDs, structured logs, `db:doctor` |
| Documentation | ✅ | 17 documents |

---

## 2. Test results — all executed today

| Suite | Checks | Result |
|---|---:|---|
| Backend unit + integration (`vitest`) | 80 | ✅ **80 / 80** |
| End-to-end API against the live server | 131 | ✅ **131 / 131** |
| Browser UI (real Chromium, 24 screens) | 98 | ✅ **98 / 98** |
| **Total** | **309** | ✅ **309 / 309** |

| Gate | Result |
|---|---|
| TypeScript errors | **0** (both projects) |
| Production build | ✅ Succeeds (both projects) |
| npm vulnerabilities | **0** (both projects) |
| Console errors across all screens, both themes | **0** |
| Horizontal overflow, 9 viewports | **0 px** |

No test was modified to make it pass. The one assertion changed during this work
was in the purification tooling's own output formatting.

---

## 3. Data state as delivered

The database shipped with this work is a **clean production database**:

| Table | Rows |
|---|---:|
| `users` | **2** — bootstrap administrators only, both requiring password rotation |
| `suppliers` | **0** |
| `items` | **0** |
| `purchase_indent_headers` | **0** |
| `purchase_order_headers` | **0** |
| `grn_headers` | **0** |
| `audit_logs` | **0** |
| `permissions` | 64 |
| `roles` | 6 |
| `google_sheet_mappings` | 9 |
| `lookups` (`is_system`) | 27 — UOM and currency only |

Demo seeding is **disabled on this database** and will not return on restart.

> **To explore the product with sample data:** `npm run db:reset`
> **To return to clean:** `npm run db:purify -- --apply`

---

## 4. What the purification tool proved about itself

After the E2E suite ran, a purge left 3 items, 1 supplier, 2 indents, 4 purchase
orders and 2 goods receipts behind.

**That was correct.** Those records were created *through the API*, exactly as a
real user would create them, so they carry no seed tag and are indistinguishable
from genuine business data. The tool refused to delete them.

This is the safety rule working on live data rather than in theory: **it will not
delete what it cannot prove is non-production.** A pristine database comes from
`db:reset -- --clean`, which builds one from scratch — not from guessing.

---

## 5. Performance — measured

Measured against the running API on this host. **No figure here is extrapolated.**

### 5.1 Single user (concurrency 1, 12 samples per endpoint)

| Endpoint | min | p50 | p99 |
|---|---:|---:|---:|
| Health (with DB ping) | 4 ms | **6 ms** | 13 ms |
| Lookup options | 10 ms | **11 ms** | 12 ms |
| Analytics — ageing | 8 ms | **15 ms** | 19 ms |
| Analytics — trends | 13 ms | **16 ms** | 18 ms |
| Analytics — breakdown | 12 ms | **16 ms** | 28 ms |
| GRN list | 15 ms | **17 ms** | 21 ms |
| Supplier search | 17 ms | **18 ms** | 22 ms |
| Audit log | 13 ms | **15 ms** | 24 ms |
| Dashboard KPIs | 32 ms | **34 ms** | 43 ms |
| Item search | 39 ms | **44 ms** | 49 ms |
| Item list | 35 ms | **46 ms** | 52 ms |
| Analytics — exceptions | 49 ms | **57 ms** | 81 ms |
| PO list | 48 ms | **59 ms** | 77 ms |
| Indent list | 62 ms | **89 ms** | 117 ms |
| **Authentication** | 411 ms | **753 ms** | 3925 ms |

**Every read is under 120 ms.** Authentication is dominated by bcrypt at cost 12
— that is the intended cost of a slow key-derivation function, not a defect.

### 5.2 Six concurrent users

| Endpoint | p50 | p99 |
|---|---:|---:|
| Health | 20 ms | 34 ms |
| Audit log | 42 ms | 43 ms |
| Analytics — ageing | 50 ms | 75 ms |
| Analytics — breakdown | 77 ms | 87 ms |
| GRN list | 121 ms | 141 ms |
| Analytics — exceptions | 158 ms | 213 ms |
| PO list | 218 ms | 324 ms |
| Dashboard KPIs | 285 ms | 344 ms |
| Item list | 296 ms | 330 ms |
| Item search | 363 ms | **2180 ms** |
| Indent list | 411 ms | 615 ms |
| **Sustained mixed, 30 s** | **217 ms** | **443 ms** at **21.3 req/s** |

**0 genuine errors.** 3,033 requests were correctly refused with HTTP 429 — the
rate limiter engaging and recovering as designed.

### 5.3 What the numbers actually say

Latency multiplies under concurrency because **PGlite is single-writer and
serialises every query**. That is a property of the embedded development driver,
not of the application: the same SQL against a real PostgreSQL server runs in
parallel across connections.

This is the measured evidence behind ADR-001's conclusion, and behind the
requirement that production sets `DB_DRIVER=pg`.

> An earlier measurement showed item search at 5,148 ms p50. That was **not** a
> slow query: the host was at 100% CPU with 0.1 GB of RAM free, and 8 concurrent
> requests were queueing behind a single-threaded engine. Measured serially on
> the same code, the same endpoint returns in 44 ms. Recorded because a
> performance number without its machine state is not a measurement.

---

## 6. Defects found and fixed in this pass

Eleven, all found by **running** the software.

| # | Defect | Severity | Status |
|---|---|---|---|
| 1 | Login headline rendered near-black on navy — contrast ~1.2:1, effectively invisible | **High** (a11y) | ✅ Fixed — headings inherit colour |
| 2 | 268 px horizontal overflow on the dashboard | Medium | ✅ Fixed — shell owns its own box |
| 3 | Every KPI label truncated ("TOTAL PO V…") — worse than v1 | Medium | ✅ Fixed — labels lead and wrap |
| 4 | Landing page broke in dark mode (dark cards on a white page) | Medium | ✅ Fixed — theme tokens |
| 5 | `zx-rise` animation referenced but undefined | Low | ✅ Fixed |
| 6 | Demo items and users carried **no marker** — purification could not identify them | **High** | ✅ Fixed — migration 006 + explicit tagging |
| 7 | Purification was **undone by the next restart** | **High** | ✅ Fixed — durable `data.purified_at` marker |
| 8 | Purge deleted masters before the users referencing them, stranding 4 lookups | Medium | ✅ Fixed — ordering corrected |
| 9 | `db:doctor` parsed the lock file as a bare PID → `NaN` → reported **live** locks as stale | **High** | ✅ Fixed — shares the driver's rule |
| 10 | CORS accepted `localhost:5173` in production | Low | ✅ Fixed |
| 11 | Express `clearCookie` deprecation warning on every logout | Low | ✅ Fixed |

Two are worth singling out.

**#9** could have caused real damage: an operator running `db:doctor` while the
backend was live would have been told the lock was stale, and might reasonably
have deleted it or forced a reset — on a database another process was writing.

**#7** would have silently reversed a deliberate production cleanup at the worst
possible moment: the first restart after go-live.

---

## 7. UI transformation

| | v1 | v2 |
|---|---|---|
| Colour ramps | 2 | **9** (11 steps each) |
| Semantic roles | 4 | **7** |
| Module identities | 0 | **6** |
| Gradients | 1 | **11** |
| Elevation levels | 3 | **9** |
| Themes | 1 | **3 states** — light / dark / follow-system |
| Animations | 2 | **13** + count-up |
| Type scale | 8 | **12**, plus a display face |

Delivered: gradient KPI medallions with count-up figures, a module-coloured
gradient sidebar, glass top bar and filter bar, an animated-mesh hero with an
engineering grid, gradient headlines, per-module feature cards, zebra tables with
hover rails, skeleton shimmer, pulsing live-status dots and a button sheen.

Every class name was preserved, so 41 components inherited the new language
without individual edits — which is why the change is this broad and the
regression count is zero.

Full detail, including the deliberate deviations, in `FINAL_UI_UX_AUDIT.md`.

---

## 8. Deployment readiness

| Artefact | Status |
|---|---|
| `deploy/docker-compose.yml` | ✅ Written — PostgreSQL 16, API, nginx; healthchecks; named volumes |
| `deploy/Dockerfile.backend` | ✅ Written — multi-stage, non-root, tini for clean SIGTERM |
| `deploy/Dockerfile.frontend` | ✅ Written — multi-stage, static-only runtime |
| `deploy/nginx.conf` | ✅ Written — proxy, CSP, rate limits, gzip, cache policy, TLS block ready |
| `deploy/install.sh` | ✅ Syntax-checked — prereqs, dirs outside the source tree, secret generation |
| `deploy/migrate.sh` | ✅ Syntax-checked — apply / `--check` / `--clean`, then verify |
| `deploy/backup.sh` | ✅ Syntax-checked — pg_dump + app export, both verified, retention |
| `deploy/restore.sh` | ✅ Syntax-checked — list / verify / dry-run / restore with safety dump |
| `deploy/.env.deploy.example` | ✅ Every variable documented |
| **Images built and started** | ⚠️ **NOT DONE** — the Docker daemon is not running here |

Two safety properties worth noting:

- `install.sh` **refuses** to place the data root inside the source tree.
- `restore.sh` takes a dump of the current database **before** overwriting it,
  and if the restore fails it restarts the API on the previous data rather than
  leaving the system down.

---

## 9. Pre-production checklist

**Data**
- [x] Demo data removed and verified
- [x] Test data removed and verified
- [x] Hard-coded business data — none exists in source
- [x] Demo seeding disabled durably
- [ ] Load your real Item and Supplier Masters

**Database**
- [x] Schema at migration 006; integrity green
- [ ] `DB_DRIVER=pg` against a real PostgreSQL server
- [ ] `ZOLEX_DATA_ROOT` on a backed-up volume with restricted permissions

**Security**
- [x] 0 npm vulnerabilities
- [x] RBAC verified server-side
- [x] Audit logging verified
- [x] Secrets excluded from source control (verified with `git check-ignore`)
- [ ] Rotate `10221` / `10422` (the software forces this — confirm it happened)
- [ ] Fresh `AUTH_SECRET` and `AUTH_REFRESH_SECRET`
- [ ] `NODE_ENV=production`; HTTPS; correct `FRONTEND_URL`

**Google Sheets**
- [x] 9 tabs mapped, headers and aliases verified
- [x] ON/OFF toggle verified
- [x] Clean degradation without credentials verified
- [ ] **Service account created and sheet shared**
- [ ] **Dry run executed**
- [ ] **Live sync executed**
- [ ] **Column set confirmed** (see `FINAL_GAP_AUDIT.md §4`)
- [ ] Add a `Supplier` column to the Purchase Order sheet

**Operations**
- [x] Backup verified (written, read back, re-checksummed)
- [x] Restore proven on a corrupted database
- [ ] Schedule `backup.sh` in cron
- [ ] **Test a restore on the production host**
- [ ] Build and start the container stack once

**Quality**
- [x] 309/309 checks · 0 TS errors · 0 build errors · 0 console errors
- [x] Responsive at 9 viewports
- [x] Performance measured
- [ ] Re-measure on the production topology

---

## 10. Residual risks

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R-1 | Google Sheets fails on first real authentication | Medium | Medium | Dry run first; it writes nothing |
| R-2 | Wrong sheet column set implemented | Medium | High | **Confirm before go-live** — `FINAL_GAP_AUDIT.md §4` |
| R-3 | Container build fails on first attempt | Low | Low | `docker compose config` then build before go-live |
| R-4 | Production performance differs from measured | Medium | Low | Real PostgreSQL should be faster under concurrency |
| R-5 | Rate limit too tight for bulk automation | Low | Medium | Raise `RATE_LIMIT_MAX`; documented |
| R-6 | Backups never restored in anger | Medium | **Critical** | **Test one.** `restore.sh --verify` is non-destructive |
| R-7 | Bootstrap password left unrotated | Low | **Critical** | The software forces rotation before any business route opens |

---

## 11. What changed, what did not

**Changed**
- Both stylesheets replaced; theme system added; KPI card, sidebar, landing and login reworked
- Migration 006 (data classification); demo tagging at creation
- Purification tooling (`purify.ts`, `cli-purify.ts`); CLI backup; `migrate --check`
- `db:reset --clean`; durable purification marker
- CORS tightened; cookie clearing corrected; lock reporting corrected; count query simplified
- Deployment package added under `deploy/`
- Six new documents

**Not changed**
- Every business rule. Quantity control, balance definitions, status machines,
  numbering, approval workflow, RBAC model, audit design, money computation and
  the database's authoritative role are all untouched.
- The API contract. No endpoint changed shape.
- The 309 checks — none was weakened to accommodate this work.

**Deleted**
- 888 demo rows, after a verified backup, with 16 assertions afterwards.
- Nothing else. No source file was deleted.

**Requires real credentials**
- Google Sheets authenticated read.

**Requires a human business decision**
- The Google Sheet column set (two conflicting specifications supplied).
- Whether to add a `Supplier` column to the Purchase Order sheet.

---

## 12. Auditor's statement

The v1.0 system arrived at 46 PASS / 1 PARTIAL / 0 FAIL. This pass did not find
that assessment wrong; it found eleven defects in work that was newly written or
newly stressed, and it closed the outstanding load-testing gap with measurements
rather than assurances.

Three of those defects were serious, and all three were invisible to code
review. The invisible login headline required looking at a rendered page. The
self-resurrecting demo data required restarting the service *after* cleaning it.
The lock-file misreport required running the doctor against a live database.
None would have been found by reading.

One requirement remains PARTIAL for a reason outside the software's control, and
one deliverable — the container images — is written but unbuilt because this host
cannot build it. Both are stated plainly rather than rounded up.

**Recommendation: CONDITIONAL GO**, subject to the three conditions at the top of
this document.
