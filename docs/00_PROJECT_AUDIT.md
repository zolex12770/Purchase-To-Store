# 00 — Project Forensic Audit (Phase 0)

**Product:** ZOLEX Purchase-to-Store Enterprise ERP
**Company:** Zeeta Electrical Engineering Pvt. Ltd.
**Audit date:** 24 August 2026
**Auditor:** Autonomous Engineering Director

---

## 1. Workspace inventory (pre-implementation)

The workspace was inspected in full before any code was written.

| Path | Type | Size | Finding |
|---|---|---|---|
| `Zolex_Purchase_to_Store_ERP_Master_SRS_SRC.pdf` | PDF, 17 pages | 60 KB | The authoritative SRS/SRC v1.0. Extracted and read in full. |

**Result: the workspace was empty apart from the SRS PDF.**

- No `frontend/`, no `backend/`, no `src/`
- No `package.json`, no lock files, no `node_modules`
- No `.env`, no configuration files
- No SQL, no migrations, no database
- No existing React / Node / TypeScript source
- No tests, no Docker files, no CI
- No `docs/`
- **Not a git repository** (`git rev-parse` reports false)

### Consequence for the "do not blindly delete existing work" rule

There is **no pre-existing implementation to preserve, reuse, or conflict with**. The
reuse-before-rebuild rule is therefore trivially satisfied for Phase 0, and remains binding for
all later phases (no module may be re-implemented once it is working).

There are **no conflicts between existing code and the SRS**, because there is no existing code.
The SRS is adopted verbatim as the product specification.

---

## 2. Toolchain inventory (host environment)

| Tool | Version | Status | Impact |
|---|---|---|---|
| OS | Windows 11 Home Single Language 26200 | ✅ | Paths, shell and line endings handled accordingly |
| Node.js | v22.14.0 | ✅ | Meets requirement (>= 20) |
| npm | 10.9.2 | ✅ | Workspace-free two-package layout |
| git | 2.54.0.windows.1 | ✅ available | Repo not initialised; `.gitignore` provided |
| Docker | 29.4.0 CLI / Compose v5.1.2 | ⚠️ **daemon not running** | Cannot be a hard dependency |
| PostgreSQL server (`psql`) | — | ❌ **not installed** | Cannot be a hard dependency |
| poppler / pdftoppm | — | ❌ not installed | SRS extracted via custom ASCII85+Flate decoder instead |

### The critical finding

> The SRS (§19, §26, §44) mandates a **SQL database, PostgreSQL recommended, located outside the
> project source folder**. The SRS (§26, §29) *also* mandates that the product starts with exactly
> `npm install && npm run dev` in each of `backend/` and `frontend/`.
>
> **On this host, neither a PostgreSQL server nor a running Docker daemon exists.** A naive
> "install PostgreSQL yourself first" design would violate the acceptance criterion that the
> project starts from the two documented commands with no undocumented manual steps.

This was the single genuinely blocking architectural decision in Phase 0. It is resolved in
[ADR-001](01_ARCHITECTURE_DECISIONS.md#adr-001--sql-engine-postgresql-dialect-with-a-dual-driver-data-layer)
and was **empirically validated, not assumed** — see §4 below.

---

## 3. Specification inventory (SRS/SRC v1.0)

Extracted 28,333 characters across 17 pages. Requirement areas identified and carried into the
traceability matrix (`docs/10_RELEASE_AUDIT.md`):

| § | Area | Phase |
|---|---|---|
| 4 | Navigation & information architecture | 4 |
| 5, 6, 18 | Roles, authentication, RBAC permission model | 3, 5 |
| 7 | Master data (Item, Supplier, supporting masters) | 6 |
| 8, 9 | Google Sheets integration + field mapping | 11 |
| 10 | Purchase Indent + approval workflow | 7 |
| 11 | Purchase Order (direct / indent / consolidated) + quantity controls | 8 |
| 12 | GRN, partial & final receipt | 9 |
| 13, 38 | Management analysis + analytics governance | 10 |
| 14 | Universal filter & drill-down standard | 4, 10 |
| 15, 16, 36 | UI/UX design system, landing page, interaction standards | 4, 13 |
| 17 | Admin module | 12 |
| 19, 20, 37 | Database architecture, integrity rules, entity relationships | 2 |
| 21 | API architecture | 3 |
| 22, 35 | Import/export and reporting | 12 |
| 23 | Backup & recovery | 12 |
| 24 | Audit logging | 3, 12 |
| 25, 27 | Security and environment configuration | 3, 13 |
| 28, 29 | Testing strategy and acceptance criteria | 14 |
| 30 | Performance & scalability targets | 13 |
| 40, 41 | Release gates and traceability matrix | 15 |

### Open decisions from SRS §44 — resolved

SRS §44 lists ten decisions to be confirmed during implementation. All ten were resolvable from
the specification, the supplied sheet structure, and standard ERP convention; none required
halting. Each is recorded with its rationale in
[01_ARCHITECTURE_DECISIONS.md](01_ARCHITECTURE_DECISIONS.md) as ADR-002 … ADR-011.

Two deserve highlighting here because they concern **defects in the supplied source data**:

1. **`Cost Center` sheet header (SRS §9, §44).** The SRS itself flags that the `Cost Center` sheet
   appears to carry a column literally named `Indent Type`. This is treated as a **source-data
   header typo**, and the sync layer uses a *configurable column mapping* that accepts either
   header for that sheet rather than hard-coding around the bug. See ADR-006.
2. **GRN has no GRN Number in the sheet mapping (SRS §9, §44).** The supplied GRN sheet is keyed
   only by PO No + Item Code. A GRN document without its own identity cannot be audited,
   corrected, or referenced. The ERP therefore **issues its own GRN number**, and treats the
   sheet's PO-keyed rows as line data. See ADR-008.

---

## 4. Empirical validation performed during the audit

Nothing below was assumed; each was executed on this host and observed.

| Probe | Result |
|---|---|
| `PGlite` reports engine version | `PostgreSQL 18.3 (PGlite 0.5.7)` |
| Exact `NUMERIC(18,4)` arithmetic (`3.3333 × 0.1`) | `0.33333000` exact — **no float drift** |
| Generated stored column with `round(qty*rate, 2)` | `0.33` correct |
| `FOREIGN KEY` violation on orphan insert | **rejected** by the engine |
| Transaction rollback after mid-transaction error | committed rows = 1, **rollback honoured** |
| CTE + window function (`sum() over ()`) | correct |
| `SELECT … FOR UPDATE` row-level lock | supported |
| Database directory outside project source | `C:\Users\SAURABH KUMAR\ZolexERP\data` ✅ |

**Conclusion:** the chosen data layer provides genuine PostgreSQL transactional and decimal
semantics, satisfying SRS §19 (SQL primary system of record), §20 (integrity rules), and the
financial-precision requirement, while preserving the two-command start-up acceptance criterion.

---

## 5. Risk register (opened at Phase 0)

| ID | Risk | Severity | Mitigation | Status |
|---|---|---|---|---|
| R-01 | No PostgreSQL server / Docker daemon on host → cannot start | **High** | Dual-driver data layer; embedded Postgres-compatible engine by default, real server via `DATABASE_URL` (ADR-001) | **Closed** — validated §4 |
| R-02 | Float arithmetic corrupts financial values | **High** | `NUMERIC(18,4)`/`NUMERIC(18,2)` in DB; `decimal.js` server-side; never `Number` for money persistence (ADR-004) | Mitigated |
| R-03 | Over-ordering / over-receipt through concurrent requests | **High** | All balance mutations inside a single transaction with `FOR UPDATE` on the source line; balances derived, never cached in mutable columns (ADR-005) | Mitigated |
| R-04 | Google Sheets sync silently overwrites approved transactions | **High** | Sync is masters-first, never mutates posted/approved transactional documents; conflicts recorded to `google_sync_errors`, never auto-resolved (SRS §8, ADR-007) | Mitigated |
| R-05 | KPI values disagree between dashboard and transaction screens | Medium | Central metric catalogue; analytics query the same SQL balance views as operational screens (SRS §38, ADR-009) | Mitigated |
| R-06 | Frontend-only permission hiding mistaken for security | **High** | Every route carries a server-side permission guard; frontend gating is cosmetic only; RBAC bypass tests in suite (SRS §25) | Mitigated |
| R-07 | A known bootstrap credential reaching production | **High** | No default password: a new database gives `10221` / `10422` the `BOOTSTRAP_ADMIN_PASSWORD` value or a random password written once to `bootstrap-admin-password.txt` in the data root (never to the log); they are seeded with `must_change_password = true` and the API refuses every route but the auth ones until it is changed; published passwords are refused (SRS §6) | Mitigated |
| R-08 | Native module build failure on Windows (e.g. `bcrypt`) | Medium | Pure-JS `bcryptjs`; no node-gyp dependency anywhere in the tree | Mitigated |
| R-09 | Secrets committed to source control | **High** | `.env` git-ignored; only `.env.example` committed; DB, backups and uploads all outside the repo | Mitigated |
| R-10 | Unbounded queries / N+1 on large datasets | Medium | Server-side pagination mandatory on every list endpoint; aggregate SQL for dashboards; indexed filter dimensions (SRS §30) | Mitigated |

---

## 6. Phase 0 verdict

| Gate | Status |
|---|---|
| Workspace inspected in full | ✅ |
| SRS read in full (17/17 pages) | ✅ |
| Existing-code inventory produced | ✅ (empty — no reusable assets, no conflicts) |
| Toolchain inventory produced | ✅ |
| Blocking architectural decision identified and resolved with evidence | ✅ |
| Risk register opened | ✅ |
| **G0 — documentation baseline** | ✅ **PASS** |

Phase 0 complete. Proceeding to Phase 1 (architecture).
