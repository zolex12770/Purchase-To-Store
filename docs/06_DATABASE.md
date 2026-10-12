# 06 — Database

**Engine:** PostgreSQL 18 dialect. Embedded (PGlite) by default, or a real
PostgreSQL server via `DB_DRIVER=pg` — the same SQL and the same migrations run on
both (ADR-001).

**Location:** `%ZOLEX_DATA_ROOT%/data` — **outside the project source**, as SRS §19
requires.

---

## 1. Migrations

Applied in filename order, each inside one transaction, recorded in
`schema_migrations` with a SHA-256 checksum. Editing an already-applied migration is
a hard error rather than a silent divergence.

| Migration | Contents |
|---|---|
| `001_core` | permissions, roles, role_permissions, users, user_roles, user_sessions, audit_logs, app_settings, document_sequences |
| `002_masters` | lookups, suppliers, items |
| `003_transactions` | purchase indent / purchase order / GRN headers and lines, `po_indent_sources`, `indent_approvals` |
| `004_ops` | google_sync_jobs, google_sync_errors, google_sheet_mappings, import_jobs, import_rows, backup_metadata |
| `005_balance_views` | the authoritative balance views |

---

## 2. Entity map

```
        roles ──< role_permissions >── permissions
          │
   users ─┴─< user_roles
     │
     ├─< user_sessions
     └─< audit_logs

  lookups (category discriminator: DEPARTMENT, COST_CENTRE, ITEM_TYPE,
           MAIN_GROUP, SUB_MAIN_GROUP, UOM, INDENT_TYPE, PO_TYPE,
           CURRENCY, PAYMENT_TERMS; parent_id gives Main → Sub cascade)
     │
     ├──────────────< items
     └──────────────< suppliers (currency, payment terms)

  purchase_indent_headers ──< purchase_indent_lines
     │                              │
     └──< indent_approvals          │  (source of demand)
                                    │
                          po_indent_sources   ← consumed_qty per source
                                    │
  purchase_order_headers ──< purchase_order_lines
     │                              │
     └──< grn_headers ──< grn_lines ┘  (receipt against a PO line)
```

**Key relationships**

- Supplier `1→N` Purchase Orders
- Item `1→N` indent lines, PO lines, GRN lines
- Indent header `1→N` indent lines · PO header `1→N` PO lines
- **A PO line may draw on MANY indent lines** through `po_indent_sources` — this is
  what makes consolidation (SRS §11.1) traceable
- PO header `1→N` GRN headers, each with `1→N` GRN lines referencing a PO line

---

## 3. The balance views — the single definition of quantity truth

Migration `005_balance_views` is the most important file in the schema. Operational
screens, server-side validation and the analytics engine **all read these views**,
which is why the dashboard reconciles with the transaction lists by construction
(SRS §34, §38; ADR-005).

### `v_indent_line_balance`

```
ordered_qty = Σ po_indent_sources.consumed_qty
              for this indent line, across POs whose status <> 'CANCELLED'
              (a DRAFT PO still holds its claim, so two users cannot draft
               purchase orders against the same quantity)

pending_qty = GREATEST(indent_qty − ordered_qty, 0)

is_eligible_for_po = indent is APPROVED
                     AND the line is not closed
                     AND pending_qty > 0
```

### `v_po_line_balance`

```
received_qty    = Σ grn_lines.grn_qty for this PO line,
                  counting POSTED GRNs only (a draft receives nothing)

pending_grn_qty = GREATEST(po_qty − received_qty, 0)

received_amount = round(received_qty    × final_rate, 2)
pending_amount  = round(pending_grn_qty × final_rate, 2)

is_receivable   = PO is not CANCELLED or SHORT_CLOSED
                  AND the line is not closed
                  AND pending_grn_qty > 0
```

### `v_po_header_balance`

Rolls the lines up and exposes `derived_status` — what ADR-003 says the status
*ought* to be given the receipts. Services recompute and persist the header status
from it after every GRN post, so a row where `status <> derived_status` is a
data-integrity alarm. `npm run db:doctor` and the exception dashboard both assert
that set is empty.

### `v_po_line_sources`

Flattens PO line → source indent line for the drill-down SRS §11.3 requires:
*where did this quantity come from, from which indent line, how much did it consume?*

---

## 4. Financial precision (ADR-004)

| Concept | Type |
|---|---|
| Quantities | `NUMERIC(18,4)` |
| Rates | `NUMERIC(18,4)` |
| Discount % | `NUMERIC(9,4)` |
| Amounts | `NUMERIC(18,2)` |

`final_rate` and `amount` on `purchase_order_lines` are **`GENERATED ALWAYS AS …
STORED`**:

```sql
final_rate NUMERIC(18,4) GENERATED ALWAYS AS
  (round(rate * (1 - discount_pct / 100), 4)) STORED,

amount NUMERIC(18,2) GENERATED ALWAYS AS
  (round(po_qty * round(rate * (1 - discount_pct / 100), 4), 2)) STORED
```

They are computed by the database, so they cannot drift from their inputs and cannot
be forged by a client. (A generated column may not reference another generated
column, which is why the expression repeats.) `grn_lines.amount` is generated the
same way.

Server-side JS money arithmetic uses `decimal.js`; `NUMERIC` is returned as **string**
so no value ever passes through a JS float on its way out of the database.

---

## 5. Integrity rules (SRS §20)

- Primary and foreign keys throughout; `ON DELETE RESTRICT` wherever history must
  survive, `CASCADE` only from a header to its own lines.
- **Partial unique indexes** for business keys: `UNIQUE … WHERE deleted_at IS NULL`,
  so a soft-deleted record never blocks reuse of its code.
- `CHECK` constraints as the last line of defence beneath the service layer:
  `qty > 0`, `discount_pct BETWEEN 0 AND 100`, `rate >= 0`, status value sets, and
  *"a rejected indent must carry a reason"* / *"a short-closed PO must carry a reason"*.
- **Soft delete** (`deleted_at`) on master records; posted transactional documents are
  never hard-deleted through the UI — they are cancelled, with a reason and an audit
  record.
- `created_by`, `created_at`, `updated_by`, `updated_at` on every business table.
- Multi-line document operations run in **one transaction** with `SELECT … FOR UPDATE`
  on the consumed source row (ADR-005).

---

## 6. Indexing (SRS §30)

Every dimension the product filters or groups by is indexed: status, date,
supplier, item, department, cost centre, PO type, indent type, item groups, plus
composite `(status, date DESC)` indexes for the default list ordering and
`(supplier_id, po_date DESC)` for supplier drill-down. Foreign keys carry their own
indexes so joins and cascade checks stay cheap.

---

## 7. Document numbering (ADR-002)

`document_sequences` holds one counter per `(doc_type, period_key)`. `nextDocumentNumber()`
locks the row with `FOR UPDATE` inside the caller's transaction, so concurrent
requests serialise instead of racing; the `UNIQUE` constraint on each document
number is the final backstop.

```
IND-YYYYMMDD-####   PO-YYYYMMDD-####   GRN-YYYYMMDD-####
```

Prefix and padding are data, not constants, so numbering can be changed without a
deployment.

---

## 8. Operating the database

| Command | Purpose |
|---|---|
| `npm run migrate` | Apply pending migrations |
| `npm run seed` | Reconcile permissions, roles, bootstrap admins, settings, sheet mappings |
| `npm run seed:demo` | The above plus a synthetic demo dataset (every row tagged `[DEMO]`) |
| `npm run db:doctor` | Connectivity, volumes and all integrity invariants |
| `npm run db:reset` | Rebuild from scratch — development only |
| `npm run db:restore -- <file>` | Offline restore from a backup |

### Concurrency and the embedded engine

The embedded engine is **single-writer**. A `.zolex.lock` file with a heartbeat
prevents two processes from opening the same directory (which would corrupt it), and
a starting process waits up to 20 seconds for a departing one to let go, so dev-server
restarts are seamless. A lock whose heartbeat has stopped is reclaimed automatically.

If the process is **force-killed** mid-write, the write-ahead log can be left without
a valid checkpoint and PostgreSQL cannot auto-repair it. The driver detects this and
prints an actionable diagnosis pointing at `db:restore` and `db:reset`. This is a
property of any embedded database and the main reason production should run
`DB_DRIVER=pg` — see [09_DEPLOYMENT.md](09_DEPLOYMENT.md) and
[04_KNOWN_ISSUES.md](04_KNOWN_ISSUES.md).
