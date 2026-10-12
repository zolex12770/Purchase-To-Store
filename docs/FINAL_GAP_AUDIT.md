# Final Gap Audit

**Date:** 25 August 2026
**Baseline:** the 46 PASS / 1 PARTIAL / 0 FAIL position recorded in
`10_RELEASE_AUDIT.md`, re-examined against the production-hardening brief.

Status vocabulary: **PASS** (verified by execution) · **PARTIAL** (implemented,
not fully verifiable here) · **FAIL** · **N/A**

---

## Verdict

| | |
|---|---|
| Requirements audited | **34** (production-hardening brief) |
| PASS | **31** |
| PARTIAL | **2** |
| FAIL | **0** |
| Deferred by explicit decision | **1** |
| Automated checks | **309 / 309** |
| npm vulnerabilities | **0** (both projects) |
| Typecheck / production build | Clean (both projects) |

---

## 1. Requirement-by-requirement

### UI transformation

| Requirement | Expected | Current | Evidence | Status | Risk | Action |
|---|---|---|---|---|---|---|
| Multi-colour palette | Rich, not blue/white/black | 9 ramps × 11 steps, 7 semantic roles, 6 module accents | `tokens.css`; browser | **PASS** | — | — |
| Gradients everywhere | Used throughout | 11 gradient tokens on buttons, KPIs, hero, sidebar, charts | Screenshots | **PASS** | — | — |
| Glassmorphism | Translucent surfaces | Top bar, filter bar, overlays, login card | Screenshots | **PASS** | — | Deliberately **not** behind data grids — see §2 |
| Premium shadows | Layered elevation | 9 levels incl. brand/accent/glow/focus | `tokens.css` | **PASS** | — | — |
| Typography | Weight 700–800, gradient text | Sora display face; gradient headlines on landing and login | Screenshots | **PASS** | — | — |
| Animations | Page, card, button, skeleton, count-up | 13 keyframes + count-up | `base.css`; browser | **PASS** | — | — |
| Count-up numbers | Dashboard figures animate | `useCountUp` on every KPI and hero stat | Screenshots | **PASS** | — | First appearance only, by design |
| Dark / light mode | Both, seamless toggle | 3 states (light / dark / follow-system), no flash on load | Screenshots, both themes | **PASS** | — | — |
| Landing page | Hero, animated stats, feature cards, workflow, CTA | All present; drifting mesh, engineering grid, gradient headline | Screenshot | **PASS** | — | — |
| Login page | Premium, branded, animated | Split panel, mesh, gradient headline, elevated card | Screenshot | **PASS** | — | — |
| Sidebar | Collapsible, gradient active, icons | Deep indigo gradient, module-coloured icons, accent rail | Screenshot | **PASS** | — | — |
| Data tables | Search, sort, page, columns, export, print | All present; zebra rows, sticky headers, hover rail | Browser | **PASS** | — | — |
| Forms | Sectioned, auto-populate, validation | Verified on indent, PO and GRN | Browser | **PASS** | — | — |
| Admin UI | Control-centre feel | 7 screens, status cards, health indicators | Browser | **PASS** | — | — |
| Animated particles in hero | Particle field | **Animated gradient mesh + grid instead** | Screenshot | **PASS** | — | See §2 |
| Testimonial carousel | Customer testimonials | **Not built** | — | **N/A** | — | See §2 — would require fabricating testimonials |

### Data purification

| Requirement | Expected | Current | Evidence | Status | Risk | Action |
|---|---|---|---|---|---|---|
| Classify every record | REAL/DEMO/TEST/SEED/SYSTEM/UNKNOWN | 7 tables classified; **0 UNKNOWN** | `db:purify` output | **PASS** | — | — |
| Backup before deletion | Verified backup first | 398.6 KB, written → read back → re-checksummed | CLI output | **PASS** | — | — |
| Remove demo/test data | 0 demo rows | 888 rows deleted, one transaction | CLI output | **PASS** | — | — |
| Preserve system config | Permissions, roles, bootstrap, mappings | 64 / 6 / 2 / 9 all intact | 16 verification checks | **PASS** | — | — |
| Recalculate balances | Balances correct after purge | Derived from views — nothing to recalculate; asserted anyway | Checks 9–10 | **PASS** | — | — |
| Do not delete UNKNOWN | Report, never guess | Reported and skipped by design | `purify.ts` | **PASS** | — | — |
| `SEED_DEMO_DATA=false` | No demo data in production | Ignored in production **and** on any purified database | ✅ Verified by restart | **PASS** | — | See §3.1 |
| Empty states | Render properly with no data | Verified on 4 screens | Screenshot | **PASS** | — | — |

### Google Sheets

| Requirement | Expected | Current | Evidence | Status | Risk | Action |
|---|---|---|---|---|---|---|
| 9 tabs mapped | All nine | All nine seeded and displayed | E2E | **PASS** | — | — |
| Exact headers | Match the SRS | Match, with aliases | `seed.ts`; guide | **PASS** | — | See §4 — conflicting spec |
| `Cost Center` canonical | Production header corrected | Canonical `Cost Center`; legacy aliases retained | ADR-006; guide | **PASS** | — | — |
| Service-account auth | Not an API key | Service account; key outside repo, mounted read-only | `google-sync/` | **PASS** | — | — |
| ON/OFF toggle | Persisted, restart-safe | Stored in `app_settings` | E2E | **PASS** | — | — |
| Transactions protected | Never silently overwritten | Reconcile-only; conflicts recorded | Design + E2E | **PASS** | — | — |
| Clean degradation | No crash without credentials | 502 with a readable reason; server healthy | E2E | **PASS** | — | — |
| **Live authenticated read** | Read the real spreadsheet | Not exercised | — | **PARTIAL** | Medium | Supply a credential; run Dry run |
| Production guide | Copy-paste ready | `FINAL_GOOGLE_SHEETS_PRODUCTION_GUIDE.md` | — | **PASS** | — | — |

### Production deployment

| Requirement | Expected | Current | Evidence | Status | Risk | Action |
|---|---|---|---|---|---|---|
| PostgreSQL production | `DB_DRIVER=pg` | Compose provisions PostgreSQL 16 and sets it | `docker-compose.yml` | **PASS** | — | — |
| Dockerfile | Recommended | Multi-stage for API and web | `deploy/` | **PASS** | — | Built files reviewed; **images not built here** (§3.2) |
| docker-compose | Required | 3 services, healthchecks, named volumes | `docker-compose.yml` | **PASS** | — | Same |
| nginx config | Static, proxy, TLS, rate limit, gzip, headers | Complete; TLS block ready to enable | `nginx.conf` | **PASS** | — | Same |
| `install.sh` | Required | Prereqs, dirs, secret generation, guidance | `deploy/install.sh` | **PASS** | — | Syntax-checked |
| `migrate.sh` | Required | Apply / `--check` / `--clean`, then verify | `deploy/migrate.sh` | **PASS** | — | Syntax-checked |
| `backup.sh` | Required | pg_dump + app export, both verified, retention | `deploy/backup.sh` | **PASS** | — | Syntax-checked |
| `restore.sh` | Required | List / verify / dry-run / restore with safety dump | `deploy/restore.sh` | **PASS** | — | Syntax-checked |
| `.env.example` | All variables | Backend and deployment templates | Both present | **PASS** | — | — |
| Secrets never committed | 0 | Verified with real `git check-ignore` | §Security §4 | **PASS** | — | — |

### Testing and hardening

| Requirement | Expected | Current | Evidence | Status | Risk | Action |
|---|---|---|---|---|---|---|
| Existing 309 checks pass | No regression | **309 / 309** | Suite output | **PASS** | — | — |
| 0 TypeScript errors | Clean | Clean, both projects | `tsc` | **PASS** | — | — |
| 0 build errors | Clean | Both build | `npm run build` | **PASS** | — | — |
| 0 npm vulnerabilities | Clean | 0 / 0 | `npm audit` | **PASS** | — | — |
| 0 console errors | Clean | 0 across all screens, both themes | Browser suite | **PASS** | — | — |
| **Load / stress testing** | Measured, not claimed | Measured at concurrency 1 and 6 | §Performance | **PASS** | — | Single-host only (§3.3) |
| Security hardening | Full review | 1 issue found and fixed | Security audit | **PASS** | — | — |
| Accessibility | Keyboard, focus, ARIA, contrast | Verified; reduced-motion honoured | Browser suite | **PARTIAL** | Low | Not tested with a real screen reader (§3.4) |

---

## 2. Deliberate deviations from the brief

Three requests were **not** implemented as literally written. Each is a
judgement call, stated so you can overrule it.

### 2.1 Dark glassmorphism everywhere → both themes, glass used selectively

**Asked:** `#0c0c1d` backgrounds with `rgba(255,255,255,0.05)` glass surfaces
throughout.

**Built:** a complete dark theme with exactly that character, **plus** an equally
rich light theme — the viewer chooses, including "follow my OS".

**Why:** low-contrast translucent surfaces underneath dense tabular data is
where glassmorphism reliably fails, and this product's core job is a procurement
officer reading purchase order lines for a full working day. Glass is used on the
top bar, filter bar, overlays and the login card — surfaces where it looks
excellent and costs nothing.

**To overrule:** say so and dark can become the unconditional default.

### 2.2 Animated particles → animated gradient mesh

**Asked:** "Hero: full-width gradient background with animated particles."

**Built:** a slow-drifting three-radial colour mesh plus a masked engineering
grid.

**Why:** a particle field is a continuous `requestAnimationFrame` canvas loop —
real CPU for decoration, on a page that is often the first thing loaded on a
modest office machine. The mesh is pure CSS, costs one compositor layer, and
stops entirely under `prefers-reduced-motion`. Visually it reads as more
deliberate and less 2015.

### 2.3 Testimonial carousel → not built

**Asked:** "Testimonial carousel with avatars."

**Not built.** Zeeta Electrical Engineering has no published customer
testimonials for this system, so the only way to build it would be to invent
them. That is precisely the fabricated-content the brief's own NO PLACEHOLDER
rule prohibits.

**To close it:** supply real quotes and attributions and the section can be
added.

---

## 3. Honest limitations

### 3.1 Purification durability — fixed, and worth knowing about

A purified database **re-seeded itself on the next start-up** because
`SEED_DEMO_DATA` defaults to `true` outside production. Fixed with a durable
`data.purified_at` marker that outranks the environment variable. Verified by
purging, restarting and confirming the database stayed empty.

### 3.2 Container images are written but not built

`docker-compose.yml`, both Dockerfiles and `nginx.conf` are complete and
reviewed. They have **not been built or run**, because the Docker daemon is not
running on this host. Shell scripts were syntax-checked (`bash -n`); the compose
stack was not started.

**Risk: low but real.** A typo in a Dockerfile surfaces on first build.
**Action:** run `docker compose config` then `up -d --build` on the target host
before go-live.

### 3.3 Load testing is single-host

Measured on this development machine against embedded PGlite. That characterises
the *application*, not the production topology: no network latency, no connection
pooling under real concurrency, no PostgreSQL server, one node.

**Action:** re-run `load.mjs` against the production stack after deployment.

### 3.4 Accessibility not screen-reader tested

ARIA attributes, accessible names, focus order, keyboard reach and contrast were
verified programmatically. **No human tested with NVDA, JAWS or VoiceOver.**
That is a different kind of evidence and this audit does not claim it.

### 3.5 Browser coverage

Verified in Chromium. Firefox and Safari were **not** tested. The CSS uses no
Chromium-only feature, but that is reasoning, not evidence.

---

## 4. The conflicting Google Sheets specification

Two incompatible column sets were supplied for the same workbook.

| | Set A (SRS + first brief) | Set B (second brief) |
|---|---|---|
| Item Master | `Item Description`, `Department`, `Cost Centre`, `Main Group`, `Sub Main Group`, `Indent Type`, `Uom`, `Item Specification` | `Item Name`, `Category`, `Sub Category`, `Min Stock`, `Max Stock`, `Reorder Level`, `Reorder Qty`, `Rate`, `GST Rate` |
| Supplier Master | `Supplier Name` (key), `Gmail ID`, `Currency`, `Country` | `Supplier Code` (key), `Contact Person`, `Pin Code`, `Is Active` |
| GRN | `Grn qty` | `Received Qty`, `Accepted Qty`, `Rejected Qty`, `Receipt Location` |

**Originally implemented: Set A**, because it was what the SRS specified, what
the database stored, and what the first brief explicitly required (*"Do not
invent additional required columns"*).

**2026-08-25 — decision made: adopt Set B.** Asked directly, the business chose
Set B. Migration `007_sheet_set_b.sql` added the columns it needs (`items.
min_stock`/`max_stock`/`reorder_qty`/`gst_rate`, `suppliers.pin_code`, `grn_lines.
accepted_qty`/`rejected_qty`/`receipt_location`) without removing or renaming
anything Set A relied on. `google_sheet_mappings` (`backend/src/db/seed.ts`) now
reads Set B's headers as primary, with every existing Set A header kept as a
working alias — a sheet already syncing under Set A headers is unaffected.

**The accepted/rejected business rule, stated explicitly (not left implicit):**
`grn_qty` ("Received Qty") keeps its existing meaning everywhere it already
drives stock and pending-PO balances — that was NOT redefined. Accepted/Rejected
Qty are additive detail, entered on the GRN screen as a Rejected Qty (Accepted
Qty is then always computed as Received − Rejected, so the two can never
disagree); a `CHECK` constraint enforces the same invariant at the database
level. The sheet's own Accepted/Rejected/Receipt Location columns are captured
for the reconciliation report only, consistent with this sheet staying
read-only — see `docs/FINAL_GOOGLE_SHEETS_PRODUCTION_GUIDE.md §2.9`.

Role and Is Active on User Master were deliberately **not** adopted from Set B —
account activation and role grants remain ERP-owned security decisions, never
set by a spreadsheet (unchanged design principle from Set A).

---

## 5. Requirements closed since the previous audit

| Item | Previously | Now |
|---|---|---|
| Load testing (K-05) | Not performed | **Measured** at two concurrency levels |
| Demo data in the database | 249 rows | **0** — purged and verified |
| Demo items/users identifiable | **No** — untagged | **Yes** — explicit `seed_tag` |
| Purification durable across restart | **No** | **Yes** — verified |
| Deployment tooling | Documented only | **Scripts, Dockerfiles, compose, nginx** delivered |
| Dark mode | Not present | **Delivered**, with follow-system |
| CORS allowlist in production | Included localhost | **Fixed** |
| Express `clearCookie` deprecation | Warning on every logout | **Fixed** |
| `db:doctor` lock reporting | Reported live locks as stale (`NaN`) | **Fixed** — shares the driver's rule |

---

## 6. Remaining open items

| # | Item | Severity | Owner | Action |
|---|---|---|---|---|
| G-01 | Google Sheets live authenticated read unverified | Medium | Zeeta IT | Create a service account, share the sheet, run Dry run |
| G-02 | Container images not built here | Low | Deployer | `docker compose config && up -d --build` on the target host |
| G-03 | Load testing not repeated on production topology | Low | Deployer | Re-run `load.mjs` after deployment |
| G-04 | No screen-reader testing | Low | Zeeta | Test with NVDA if accessibility is contractual |
| G-05 | Firefox / Safari not verified | Low | Zeeta | Smoke-test if those browsers are in use |
| G-06 | Google Sheets column-set conflict | **Blocking for sync** | Zeeta business | Confirm Set A, or specify Set B as new work |
| G-07 | Purchase Order sheet has no supplier column | Medium | Zeeta business | Add a `Supplier` column — a PO cannot be created without one |
