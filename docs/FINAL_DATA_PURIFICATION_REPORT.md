# Final Data Purification Report

**Date:** 25 August 2026
**Command:** `npm run db:purify -- --apply`
**Outcome:** ✅ Complete and verified — 884 rows removed, 16/16 checks passed

---

## 1. What purification does

It removes demo and test data so a database can go into production, under four
rules that are enforced in code, not by convention:

1. **Nothing is deleted that cannot be proved non-production.** An unclassified
   row is reported as UNKNOWN and left alone. Deleting a customer's real record
   is unrecoverable in a way that leaving a stray demo row is not.
2. **A verified backup is taken first.** The file is written, read back and
   re-checksummed. If that fails, the purge is refused.
3. **Everything happens in one transaction.** A half-purified database is not an
   outcome this can produce.
4. **The result is verified, not assumed.** Sixteen assertions run afterwards.

Default behaviour is a **dry run**. Nothing is deleted without `--apply`.

---

## 2. Before

| Table | Total | Real | **Demo** | Test | System | Unknown |
|---|---:|---:|---:|---:|---:|---:|
| `purchase_indent_headers` | 68 | 0 | **68** | 0 | 0 | 0 |
| `purchase_order_headers` | 39 | 0 | **39** | 0 | 0 | 0 |
| `grn_headers` | 33 | 0 | **33** | 0 | 0 | 0 |
| `items` | 36 | 0 | **36** | 0 | 0 | 0 |
| `suppliers` | 12 | 0 | **12** | 0 | 0 | 0 |
| `users` | 9 | 0 | **7** | 0 | 2 | 0 |
| `lookups` | 81 | 0 | **54** | 0 | 27 | 0 |
| **Business rows** | **278** | **0** | **249** | **0** | **29** | **0** |

Dependent rows: 199 indent lines · 122 PO lines · 89 PO sources · 100 GRN lines ·
122 approvals.

**Unknown: 0.** Every row was positively classified before anything was deleted.

---

## 3. Safety backup

| | |
|---|---|
| File | `zolex-pre-purify-2026-08-25T02-57-38-176Z.json` |
| Size | 398.6 KB |
| Tables captured | 25 |
| SHA-256 | recorded in `backup_metadata`, status `VERIFIED` |
| Verification | Written → **read back** → re-checksummed → re-parsed |
| Location | `C:\Users\SAURABH KUMAR\ZolexERP\backups\` — **outside the repository** |

---

## 4. Deleted

Foreign-key-safe order, one transaction:

| Table | Rows deleted |
|---|---:|
| `grn_lines` | 100 |
| `grn_headers` | 33 |
| `po_indent_sources` | 89 |
| `purchase_order_lines` | 122 |
| `purchase_order_headers` | 39 |
| `indent_approvals` | 122 |
| `purchase_indent_lines` | 199 |
| `purchase_indent_headers` | 68 |
| `user_roles` | 7 |
| `users` | 7 |
| `items` | 36 |
| `suppliers` | 12 |
| `lookups` | 54 |
| **Total** | **888** |

---

## 5. Retained, and why

| Table | Rows | Reason |
|---|---:|---|
| `permissions` | 64 | The permission catalogue. RBAC cannot function without it |
| `roles` | 6 | Default role definitions |
| `role_permissions` | 160 | Role/permission grants |
| `users` | 2 | Bootstrap administrators `10221` and `10422` |
| `app_settings` | 13 | System configuration (+1: the purification marker) |
| `google_sheet_mappings` | 9 | Sheet field mappings for all 9 tabs |
| `document_sequences` | 120 | Document numbering counters |
| `lookups` (`is_system`) | 27 | UOM and currency — international standards, not company data |
| `audit_logs` | 2 | **Deliberately kept**: the audit trail is the evidence the purge happened |
| `schema_migrations` | 6 | Migration ledger |

The audit log is retained by default. `--purge-audit` clears it, but destroying
the record of a data deletion is rarely what an auditable system should do
quietly.

---

## 6. After

| Table | Before | After |
|---|---:|---:|
| `items` | 36 | **0** |
| `suppliers` | 12 | **0** |
| `lookups` | 81 | **27** (system only) |
| `users` | 9 | **2** (bootstrap only) |
| `purchase_indent_headers` | 68 | **0** |
| `purchase_order_headers` | 39 | **0** |
| `grn_headers` | 33 | **0** |

---

## 7. Verification — all 16 passed

| # | Check | Result |
|---|---|---|
| 1 | No demo/test indents remain | ✅ |
| 2 | No demo/test purchase orders remain | ✅ |
| 3 | No demo/test goods receipts remain | ✅ |
| 4 | No `[DEMO]`-marked documents remain | ✅ |
| 5 | No orphaned indent lines | ✅ |
| 6 | No orphaned PO lines | ✅ |
| 7 | No orphaned GRN lines | ✅ |
| 8 | No orphaned PO source references | ✅ |
| 9 | Quantity balances remain consistent | ✅ |
| 10 | Stored PO status still matches the derived status | ✅ |
| 11 | Permission catalogue intact (64) | ✅ |
| 12 | Default roles intact (6) | ✅ |
| 13 | Bootstrap administrators intact | ✅ |
| 14 | An active Super Admin still exists | ✅ |
| 15 | Google sheet mappings intact (9 sheets) | ✅ |
| 16 | System lookups (UOM / currency) intact | ✅ |

Balances needed no recalculation: they are **derived from SQL views**, never
stored in counters, so removing rows cannot leave a stale total behind. Checks
9 and 10 assert that anyway rather than taking it on trust.

---

## 8. Two defects found while doing this

Both were found by running the tooling, not by reading it.

### 8.1 Demo masters could not be identified

Demo **items** and **users** carried no marker at all — only suppliers, lookups
and transaction headers did. A purge had no reliable way to tell a demo item
from a real one.

- Migration `006_data_classification.sql` adds an explicit, indexed `seed_tag`
  column to the seven tables holding business data, and backfills it from the
  markers that did exist.
- All nine demo `INSERT` statements now set `seed_tag = 'demo'` at creation.
- **Effect:** demo users correctly classified went from **2 of 7 → 7 of 7**.

The migration's backfill is deliberately conservative. It tags a row only where
that is *provable* from the data — an item referenced by demo documents and by
nothing else. Rows it cannot prove are left for a human, which is why the first
run reported 5 users as REAL. After the explicit tagging was in place, a fresh
seed classified all 7 correctly.

### 8.2 The purge deleted masters before the users that referenced them

Demo departments survived the first purge because demo **users** still held a
`department_id` when the lookup cleanup ran, so the "still referenced" guard
correctly protected them — from data that was about to be deleted moments later.

- **Fixed:** demo users are now deleted *before* the master cleanup.
- **Effect:** `lookups` went from 81 → **31** (4 stranded) to 81 → **27** (clean).

---

## 9. Third defect: purification was not durable

Covered in full in `FINAL_FORENSIC_INVENTORY.md §4`. In short: a purified
database **re-seeded itself on the next start-up**, because `SEED_DEMO_DATA`
defaults to `true` outside production.

Fixed by recording `data.purified_at` in `app_settings`. `seedDemoData()` honours
it **regardless of the environment variable**:

```
WARN  This database has been purified for production — demo seeding refused.
      Run `npm run db:reset` if you deliberately want demo data back.
```

Verified by purifying, restarting, and confirming the database stayed empty.

---

## 10. Commands

| Command | Effect |
|---|---|
| `npm run db:purify` | **Dry run.** Classifies and reports. Changes nothing |
| `npm run db:purify -- --apply` | Backup → purge → verify |
| `npm run db:purify -- --apply --purge-audit` | Also clears the audit log |
| `npm run db:purify -- --json` | Machine-readable output |
| `npm run db:reset -- --clean` | Fresh **empty production** database (no demo, and none later) |
| `npm run db:reset` | Fresh database **with** demo data, for evaluation |
| `npm run db:doctor` | Integrity check at any time |

---

## 11. Delivered state

The database shipped with this work is a **clean production database**:

- **0** demo indents, purchase orders, goods receipts, items or suppliers
- **2** users — the bootstrap administrators, both requiring password rotation
- **27** system lookups (UOM, currency)
- **64** permissions, **6** roles, **9** sheet mappings — intact
- Demo seeding is **disabled** and will not return on restart

To explore the product with sample data instead, run `npm run db:reset`. Every
row it creates is tagged, and `npm run db:purify -- --apply` removes them again.
