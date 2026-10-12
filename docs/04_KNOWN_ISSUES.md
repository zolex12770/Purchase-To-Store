# 04 — Known Issues & Limitations

Honest record of what is not done, not perfect, or worth knowing before relying on
this system. Nothing here is hidden behind a "complete" claim.

Status key — **OPEN** (needs work) · **BY DESIGN** (deliberate, documented) ·
**RESOLVED** (found and fixed during this build).

---

## OPEN

### K-01 · Embedded database can be corrupted by a force-kill
**Severity: High (development) / Not applicable in production**

`DB_DRIVER=pglite` runs PostgreSQL in-process. Killing that process mid-write
(`taskkill /F`, `kill -9`, power loss) can leave the write-ahead log without a valid
checkpoint, and PostgreSQL cannot auto-repair it.

*Encountered during this build* when a force-kill was used to free a port; the
database became unopenable and had to be rebuilt.

**Mitigations already implemented**
- A `.zolex.lock` heartbeat file prevents two processes opening the directory at once
  (the other way to corrupt it), and a starting process waits up to 20 s for a
  departing one so dev-server restarts are seamless.
- The driver detects checkpoint damage and prints an actionable diagnosis instead of
  an opaque WASM abort.
- `npm run db:restore -- <file>` recovers offline; `npm run db:reset` rebuilds.
- `npm run db:doctor` reports directory, lock and integrity state.

**Fix:** use `DB_DRIVER=pg` in production. Stop the service with Ctrl+C/SIGTERM.

---

### K-02 · Rate limiting is per-process
**Severity: Medium (only when running more than one node)**

`express-rate-limit` uses in-memory storage, so N API nodes multiply the effective
limit by N, and a restart clears the counters.

**Fix:** a shared store (`rate-limit-redis`) when moving to multiple nodes. Single-node
deployments are unaffected.

---

### K-03 · Google Sheets sync is untested against a live spreadsheet
**Severity: Medium**

The sync engine, mappings, conflict recording, toggle, scheduler and job history are
implemented and tested for the **unconfigured** path (it degrades to a clear "not
configured" state and never crashes). No Google service-account credential was
available in this environment, so the authenticated read path has not been exercised
against the real sheet.

**What is verified:** mappings seeded for all nine sheets, header aliases including
the `Cost Center` naming defect (ADR-006), toggle persisted in `app_settings`, a run
without credentials failing cleanly with 502 and leaving the server healthy.

**To validate:** supply `GOOGLE_SERVICE_ACCOUNT_KEY_FILE`, share the sheet with the
service account, and run **Dry run** first — it reads and validates without writing.

---

### K-04 · No automated browser test suite in the repository
**Severity: Low**

UI verification was performed with a real Chromium driving all 24 screens (98 checks:
console cleanliness, overflow, drill-down, search, responsive, accessibility), but the
harness lives in the session scratchpad rather than the repository, and no Playwright
dependency was added to `frontend/`.

**Fix:** add `@playwright/test` and commit the specs if browser tests should run in CI.

---

### K-05 · Analytics recompute on every request
**Severity: Low — now measured rather than assumed**

Dashboard aggregates run against the balance views on each call; nothing is cached.

**Measured (v1.1), single user:** dashboard KPIs 34 ms p50 / 43 ms p99, trends
16 ms, breakdown 16 ms, ageing 15 ms, exceptions 57 ms. **Six concurrent users:**
KPIs 285 ms p50 / 344 ms p99.

Latency multiplies under concurrency because PGlite is single-writer and
serialises queries — a property of the embedded development driver, not of the
queries. Production uses `DB_DRIVER=pg`, where connections run in parallel.

**Fix if it becomes slow:** short-TTL caching on the KPI endpoint, or
materialised views refreshed on a schedule. Deliberately not done yet — caching a
KPI that must reconcile with the transaction lists is a correctness risk worth
taking only when the numbers demand it. They do not.

---

## BY DESIGN

### K-06 · Transactional sheets are reconciled, never imported
Purchase Indent, Purchase Order and GRN sheet rows are **compared** against the ERP,
and divergences are recorded as conflicts for a human to resolve. They are never
written.

*Why:* SRS §8 forbids sync from silently overwriting protected transactional records,
and creating documents from a spreadsheet would bypass the numbering, approval and
quantity controls that make them trustworthy. Master data (items, suppliers, users,
lookups) **is** synced, because that is the migration path the SRS describes.

### K-07 · Import is limited to master data
Same reasoning. `/io/import` accepts Item Master, Supplier Master and User Master.
The API says so explicitly in its response.

### K-08 · Tax/GST is captured but not calculated
`HSN Code` and supplier `GST No` are recorded and exported. No tax engine exists,
because SRS §3.2 excludes accounting/GL and §11.2 defines the PO line as
Rate → Discount % → Final Rate → Amount with no tax field. Adding one would be scope
invention. (ADR-011)

### K-09 · Single-level approval
An indent in `PENDING_APPROVAL` is actioned by any holder of `indent.approve`. The
`indent_approvals` table already carries a `level` column, so a multi-level chain can
be added without a schema migration. (ADR-011)

### K-10 · Users imported from a sheet arrive inactive
Sync-created users get an unusable password hash, `is_active = false` and the Viewer
role, and a warning is recorded. A spreadsheet must never be able to create a usable
login.

### K-11 · Deletion degrades to deactivation where history exists
Deleting a master that is referenced deactivates it instead, and the response says so
explicitly. Posted transactional documents are never hard-deleted — they are cancelled
with a mandatory reason. (SRS §20)

### K-12 · Demo data ships by default in development
`npm run db:reset` creates 68 indents, 39 POs and 33 GRNs across seven months so
analytics and drill-down are meaningful immediately. **Every row now carries an
explicit `seed_tag = 'demo'`** (v1.1), not just a `[DEMO]` text prefix, so it can
be identified and removed with certainty.

- Remove it: `npm run db:purify -- --apply` (backs up first, verifies after)
- Never create it: `npm run db:reset -- --clean`
- Both record a durable marker, so a restart cannot bring demo data back.

**The database delivered with v1.1 is clean** — 0 demo rows, 2 bootstrap users.

---

## RESOLVED during this build

Recorded because each was a genuine defect found by verification rather than by
inspection.

| # | Defect | How it surfaced | Fix |
|---|---|---|---|
| R-01 | Dashboard PO value disagreed with the PO list total by exactly the value of a cancelled order | Integration test asserting reconciliation | The list total now excludes cancelled orders, matching the `po_value_total` metric definition; cancelled value is reported separately so nothing is hidden (ADR-009) |
| R-02 | Session did not survive a page reload; every screen 401'd | Browser verification | The client fired two refresh calls on boot (React StrictMode double-invokes effects). Since the server **rotates** refresh tokens, the second presented an already-revoked one. Fixed by routing session restore through the shared single-flight `refreshSession()`. |
| R-03 | An expired session tripped the sign-in rate limiter, locking the user out of signing in | Browser verification (cascade of 429s) | `/auth/login` and the other auth routes now have separate budgets; failed refreshes no longer count against sign-in |
| R-04 | Backup restore failed on `jsonb` columns holding JSON strings | Offline restore attempt | Column types are now read from the catalogue and json/jsonb values re-serialised. Restore logic is shared by the API and the CLI so the two cannot diverge. |
| R-05 | A failed database open poisoned the connection singleton, so repair tooling could never retry | Restore attempt after corruption | The cached promise is cleared on rejection |
| R-06 | Directory rebuild failed on Windows because the failed open still held file handles | Restore attempt | Openability is now probed in a disposable child process, so the repairing process holds no handles |
| R-07 | Sidebar forced horizontal scrolling at 820 px | Responsive check | The sidebar auto-collapses to its icon rail below 1100 px |
| R-08 | Detail panels collapsed to one column, making documents needlessly tall | Screenshot review | `DetailGrid` track minimum corrected |
| R-09 | A 401 appeared in the browser console on the public landing page | Browser verification | `/auth/refresh` now answers 200 `{authenticated:false}` when no session exists — that is a normal state, not an error |
| R-10 | `tx` argument omitted in 8 transaction helper calls | First typecheck | Corrected; typecheck now runs after every change |
| R-11 | 10 dependency vulnerabilities, 1 critical | `npm audit` | Upgraded `googleapis` and `vitest`, pinned a patched `uuid` via overrides. **Both projects now report 0 vulnerabilities.** |
| R-12 | React Router open-redirect advisory | `npm audit` | Upgraded to v7 before any router code was written |

---

## RESOLVED during production hardening (v1.1)

Eleven defects, every one found by **running** the software rather than reading
it. Three of them were invisible to code review by construction.

| # | Defect | Severity | How it surfaced | Fix |
|---|---|---|---|---|
| R-13 | Login headline rendered near-black on the dark navy panel — roughly 1.2:1 contrast, effectively invisible | **High** (a11y) | Reading a captured screenshot | The new stylesheet pinned `h1…h6 { color: var(--text-primary) }`, overriding inheritance on dark brand panels. Headings now `inherit`, which corrected every dark-panel heading at once |
| R-14 | 268 px horizontal overflow on the dashboard — exactly the sidebar width | Medium | Browser harness measuring `scrollWidth − clientWidth` | `.app-main { width: 100% }` sat on a wrapper already carrying `margin-left: var(--sidebar-w)`. The stylesheet no longer sets that element's box |
| R-15 | Every KPI label truncated ("TOTAL PO V…") — strictly worse than v1 | Medium | Reading a screenshot | The new icon medallion had taken the label's horizontal budget. Labels now lead at full width and wrap to two lines, with the height reserved so cards still align |
| R-16 | Landing page broke in dark mode — dark cards on a white page | Medium | Dark-theme screenshot | The page pinned `--white` and a literal white header while its `.card` children followed the theme. Now uses `--bg-surface` / `--glass-bg` |
| R-17 | `zx-rise` animation referenced but never defined | Low | Cross-checking animation names against the stylesheet | Added; the motion was correct, only the definition was missing |
| R-18 | Demo items and users carried **no marker at all** — purification could not tell them from real records | **High** | Attempting to write the purge | Migration 006 adds an explicit `seed_tag`; all nine demo inserts now set it. Correctly classified demo users rose from **2 of 7 to 7 of 7** |
| R-19 | Purification was **undone by the next restart** | **High** | Restarting the service after cleaning it, and finding 36 items back | `SEED_DEMO_DATA` defaults to `true` outside production, so start-up re-created the missing rows. A durable `data.purified_at` marker now outranks the environment variable entirely |
| R-20 | The purge deleted masters before the users referencing them, stranding four department lookups | Medium | Investigating why `lookups` stopped at 31 instead of 27 | Demo users hold a `department_id`, so the "still referenced" guard correctly protected departments from data that was about to be deleted moments later. Users are now removed first |
| R-21 | `db:doctor` reported **live** database locks as stale | **High** | Noticing `Stale lock from process NaN` in real output | The doctor parsed the lock file as a bare PID while the driver wrote JSON, so `Number(...)` gave `NaN` and the liveness probe always failed. An operator could have been told it was safe to clear a lock another process was actively holding. Both now share one exported rule |
| R-22 | CORS accepted `http://localhost:5173` in production | Low | Security review of the allowlist | Development origins are included only when `NODE_ENV !== production` |
| R-23 | Express `clearCookie` deprecation warning on every logout | Low | Test output | Cookie identity attributes and lifetime are now separate, sharing one definition so they cannot drift |

### One more, in the tooling rather than the product

`.gitignore`'s `.env.*` rule silently matched `deploy/.env.deploy.example`, which
would have excluded the deployment template from the delivered repository — the
one file a deployer needs first. Caught by testing the rules with real
`git check-ignore` rather than trusting them, and fixed with an explicit
negation.
