# Final Forensic Inventory

**Scope:** every file in `frontend/`, `backend/`, `docs/`, `deploy/` and the
external data root, audited for hard-coded business data, demo data, mock data,
placeholders and development-only assumptions.
**Method:** exhaustive pattern search across all source files, plus a live
classification of every row in the database.
**Date:** 25 August 2026

---

## Verdict

| Category | Found | Action |
|---|---|---|
| Hard-coded **business** data in source | **0** | — |
| Mock / fake / stub API responses | **0** | — |
| Placeholder text (Lorem ipsum, "coming soon", TODO, FIXME) | **0** | — |
| Static KPI or chart values presented as real | **0** | — |
| Stray `console.log` in the frontend | **0** | — |
| `console.log` in the backend | 22 | **Kept** — all are CLI/diagnostic output |
| Demo rows in the database | **249** | Classified, then **purged and verified** |
| Rows that could not be classified | **0** | — |

No source file had to be changed to remove business data, because none contained
any. The demo data lived where it should — in the database, created by a seed
script, and tagged.

---

## 1. Source scan

Searched for: `[DEMO]`, `MOCK_`, `FAKE_`, `SAMPLE_`, `DUMMY_`, `STATIC_`,
`mockData`, `fakeData`, `sampleData`, `placeholderData`, `TODO`, `FIXME`,
`coming soon`, `lorem ipsum`, `not implemented`, hard-coded supplier and item
names, employee names, quantities, rates and dropdown values.

### 1.1 Frontend — clean

| Finding | Location | Assessment |
|---|---|---|
| `'Zeeta Electrical Engineering Pvt. Ltd.'` | `AppShell.tsx:882` | **Legitimate.** A fallback for the DB-driven `company.name` setting; the database value wins |
| `'Zeeta Electrical Engineering Pvt. Ltd.'` | `Login.tsx`, `Landing.tsx` | **Legitimate.** Product branding on the sign-in and marketing pages |
| `placeholder="CBL-CU-3C25"` | `Items.tsx:436` | **Format hint** in an input placeholder — never submitted, never displayed as data |
| `HERO_STATS` (6 / 4 / 24 / 100%) | `Landing.tsx` | **Legitimate.** These describe the *software* (module count, PO modes, KPI count), not any customer's business data |

Every dropdown, every list and every KPI is fed from an API call. There is no
code path in the frontend that produces a supplier, item, department, cost
centre, PO type, indent type, quantity or rate that did not come from the
database.

**Confirmed by search:** zero matches for `MOCK_`, `FAKE_`, `mockData`,
`sampleData` or `placeholderData` outside `node_modules`.

### 1.2 Backend — clean, with demo data correctly quarantined

| Finding | Location | Assessment |
|---|---|---|
| `DEMO_LOOKUPS`, `DEMO_ITEMS`, `DEMO_SUPPLIERS`, `DEMO_USERS` | `db/seed.ts` | **Correct by design.** Confined to the seed module, only ever run by `seedDemoData()`, and every row it writes is tagged |
| `seedSystem()` catalogues | `db/seed.ts` | **System data, not business data.** The 64 permissions, 6 roles, 9 sheet mappings and international UOM/currency lookups. Required for the application to run |
| 22 × `console.log` | `cli-doctor`, `cli-restore`, `driver`, `logger`, `env`, `index` | **Kept.** These are CLI tools and the startup banner — console output *is* their interface. Application logging goes through `core/logger.ts` |

**No hard-coded business values exist in any route, service or domain module.**

### 1.3 Defect found and fixed during this audit

Demo **items** and **users** were created *without any marker at all* — only
suppliers, lookups and the transaction headers carried one. A purge could not
have distinguished a demo item from a real one.

- **Fixed:** migration `006_data_classification.sql` adds an explicit, indexed
  `seed_tag` column to the seven tables that carry business data.
- **Fixed:** all nine demo `INSERT` statements in `seed.ts` now set
  `seed_tag = 'demo'` at creation, so classification is recorded rather than
  inferred.
- **Verified:** demo users classified correctly rose from 2 of 7 to **7 of 7**.

---

## 2. Database inventory (before purification)

Measured live, not estimated.

### Business data

| Table | Total | Real | Demo | Test | System | Unknown |
|---|---:|---:|---:|---:|---:|---:|
| `purchase_indent_headers` | 68 | 0 | **68** | 0 | 0 | 0 |
| `purchase_order_headers` | 39 | 0 | **39** | 0 | 0 | 0 |
| `grn_headers` | 33 | 0 | **33** | 0 | 0 | 0 |
| `items` | 36 | 0 | **36** | 0 | 0 | 0 |
| `suppliers` | 12 | 0 | **12** | 0 | 0 | 0 |
| `users` | 9 | 0 | **7** | 0 | 2 | 0 |
| `lookups` | 81 | 0 | **54** | 0 | 27 | 0 |

### Operational / history

| Table | Rows | Basis |
|---|---:|---|
| `purchase_indent_lines` | 199 | Follows its indent header |
| `purchase_order_lines` | 122 | Follows its PO header |
| `po_indent_sources` | 89 | Follows its PO header |
| `grn_lines` | 100 | Follows its GRN header |
| `indent_approvals` | 122 | Follows its indent header |
| `audit_logs` | 35 | Immutable history — retained |
| `import_jobs` / `import_rows` | 0 / 0 | Import history |
| `google_sync_jobs` / `google_sync_errors` | 0 / 0 | Sync history |
| `backup_metadata` | 0 | Backup catalogue |
| `user_sessions` | 48 | Live sessions |

### System — never purged

| Table | Rows | Why it must survive |
|---|---:|---|
| `permissions` | 64 | The permission catalogue. Without it, RBAC cannot function |
| `roles` | 6 | Default role definitions |
| `role_permissions` | 160 | Role/permission grants |
| `user_roles` | 9 | Role assignments |
| `app_settings` | 12 | System configuration |
| `google_sheet_mappings` | 9 | Sheet field mappings |
| `document_sequences` | 120 | Document numbering counters |
| `schema_migrations` | 6 | Migration ledger |
| `lookups` where `is_system` | 27 | UOM and currency — international standards, not company data |

**Total classified as demo/test: 249 business rows** (884 rows including their
dependent lines and approvals).
**Total unclassifiable: 0.**

---

## 3. Development-only assumptions

| Assumption | Where | Production impact |
|---|---|---|
| `DB_DRIVER=pglite` default | `config/env.ts` | **Documented.** Production sets `DB_DRIVER=pg`; `deploy/docker-compose.yml` does this |
| `SEED_DEMO_DATA=true` default | `config/env.ts` | Ignored when `NODE_ENV=production`, **and** ignored on any purified database (see §4) |
| `localhost:5173` CORS origin | `config/env.ts` | Overridden by `FRONTEND_URL` |
| Development credential hint on the login screen | `Login.tsx` | Rendered only when `import.meta.env.DEV`; absent from a production build |
| `secure: false` on cookies | `auth/routes.ts` | Tied to `env.isProd` — becomes `true` automatically in production |

None of these leak into a production build.

---

## 4. Defect found: purification was not durable

During verification, a purified database **re-seeded itself with demo data on
the next start-up**. `SEED_DEMO_DATA` defaults to `true` outside production, and
the start-up seeder noticed the demo rows were missing and helpfully recreated
them — silently undoing a deliberate production cleanup.

This is the kind of thing that only shows up when you actually restart the
service after cleaning it, which is why it was found by testing rather than by
reading the code.

**Fixed** by making the cleanup durable rather than depending on an environment
variable someone might forget:

- `db:purify -- --apply` writes an `app_settings` marker, `data.purified_at`.
- `db:reset -- --clean` writes the same marker.
- `seedDemoData()` checks it first and refuses, **regardless of
  `SEED_DEMO_DATA`**, logging exactly why.
- `db:reset` (without `--clean`) drops the schema, clearing the marker — so
  getting demo data back for evaluation is still one command.

**Verified by execution.** After purifying and restarting, the log reads:

```
WARN  This database has been purified for production — demo seeding refused.
      Run `npm run db:reset` if you deliberately want demo data back.
```

---

## 5. Non-source artefacts

| Item | Status |
|---|---|
| `backend.zip` (99 MB) in the project root | **Not created by this work.** 20,870 of its 21,197 entries are `node_modules`. Inspected: it contains **no** `.env` and no credentials — only `.env.example`. Left in place; `*.zip` added to `.gitignore` so a dependency archive can never be committed |
| Database, backups, uploads, logs | Confirmed at `C:\Users\SAURABH KUMAR\ZolexERP\` — **outside the repository** |
| Committed `.env` files | **0** |
| Committed database or backup files | **0** |
| Committed credentials or key files | **0** |

`.gitignore` behaviour was **verified with real `git check-ignore`**, not assumed:

| Path | Result |
|---|---|
| `backend/.env` | IGNORED ✅ |
| `deploy/.env.deploy` | IGNORED ✅ |
| `test.zip` | IGNORED ✅ |
| `backend/.env.example` | committable ✅ |
| `deploy/.env.deploy.example` | committable ✅ |
| `deploy/install.sh`, `deploy/nginx.conf` | committable ✅ |

> A rule worth recording: `.env.*` matched `deploy/.env.deploy.example` and would
> have silently excluded the deployment template from the delivered repository.
> An explicit `!deploy/.env.deploy.example` negation was added and re-verified.

---

## 6. Conclusion

The source code was already free of hard-coded business data — that requirement
was met by the original build and this audit confirms it rather than repairs it.

Two genuine defects were found, both in the *management* of demo data rather
than in its containment:

1. Demo items and users were untagged, making reliable purification impossible.
2. Purification was undone by the next restart.

Both are fixed, and both fixes were verified by running the software.
