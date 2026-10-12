# 07 — API Reference

Base URL: `/api/v1` · JSON in, JSON out · Bearer token auth (SRS §21).

---

## 1. Conventions

### Response envelope

```jsonc
// success
{ "success": true, "data": <payload>, "meta": { ... } }

// failure — stack traces are logged server-side, never serialised
{ "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Please correct the highlighted fields.",
    "issues": [{ "field": "indentQty", "message": "Must be greater than zero." }],
    "requestId": "0f2c…"
  } }
```

### Error codes

| Code | HTTP | Meaning |
|---|---|---|
| `VALIDATION_ERROR` | 422 | Malformed input; `issues[]` names the fields |
| `BUSINESS_RULE_VIOLATION` | 422 | Well-formed but breaks a domain rule (quantity, workflow, status) |
| `AUTHENTICATION_ERROR` | 401 | Missing, invalid or expired session |
| `AUTHORIZATION_ERROR` | 403 | Authenticated but lacking the permission |
| `NOT_FOUND` | 404 | No such record or endpoint |
| `CONFLICT` | 409 | Duplicate key, or a reference that prevents the operation |
| `INTEGRATION_ERROR` | 502 | Google Sheets or another external system |
| `RATE_LIMITED` | 429 | Too many requests |
| `SERVER_ERROR` | 500 | Unexpected — logged with a request id |

### List query standard

Every list endpoint accepts:

```
?page=1&pageSize=25&search=cable&sortBy=poDate&sortDir=desc
```

plus the universal filter dimensions where they apply — `dateFrom`, `dateTo`,
`supplierId`, `itemId`, `departmentId`, `costCentreId`, `indentTypeId`, `poTypeId`,
`mainGroupId`, `subMainGroupId`, `itemTypeId`, `userId`, `status`. Multi-value
filters are comma-separated (`?status=OPEN,PARTIALLY_RECEIVED`).

Responses carry pagination in `meta`:

```jsonc
"meta": { "page": 1, "pageSize": 25, "total": 412, "totalPages": 17,
          "hasNext": true, "hasPrev": false }
```

`sortBy` is resolved against a **server-controlled allow-list** — a sort column can
never be parameterised in SQL, so this is the only safe way to build `ORDER BY`.

---

## 2. Authentication — `/auth`

| Method | Path | Permission | Notes |
|---|---|---|---|
| POST | `/auth/login` | — | `{ employeeId, password }` → access token + `httpOnly` refresh cookie. Rate-limited on failures only. |
| POST | `/auth/refresh` | — | Rotates the refresh token. Returns `{ authenticated: false }` with **200** when no session exists — that is a normal state, not an error. |
| POST | `/auth/logout` | — | Revokes the session server-side |
| GET | `/auth/me` | authenticated | Identity, roles and **live** permissions (a revoked grant takes effect at once) |
| POST | `/auth/change-password` | authenticated | Rotates own password; revokes every other session |

A user whose password must be rotated is refused every non-auth route until they do.

---

## 3. Master data

### Supporting masters — `/lookups`

| Method | Path | Permission |
|---|---|---|
| GET | `/lookups/options` | authenticated |
| GET | `/lookups/categories` | `lookup.view` |
| GET | `/lookups/:category` | `lookup.view` |
| POST | `/lookups/:category` | `lookup.create` |
| PUT | `/lookups/:category/:id` | `lookup.edit` |
| DELETE | `/lookups/:category/:id` | `lookup.delete` |
| GET | `/lookups/:category/:id/usage` | `lookup.view` |

`GET /lookups/options` returns every dropdown source in one call — the frontend
caches it, so no screen hard-codes a business value and no form makes ten round-trips.

Categories: `DEPARTMENT`, `COST_CENTRE`, `ITEM_TYPE`, `MAIN_GROUP`,
`SUB_MAIN_GROUP`, `UOM`, `INDENT_TYPE`, `PO_TYPE`, `CURRENCY`, `PAYMENT_TERMS`.

**Delete degrades to deactivate** when the value is referenced, so history survives.

### Suppliers — `/suppliers` · Items — `/items`

| Method | Path | Permission |
|---|---|---|
| GET | `/suppliers` · `/items` | `*.view` |
| GET | `/suppliers/search` · `/items/search` | `*.view` |
| **GET** | **`/suppliers/:id/profile`** · **`/items/:id/profile`** | `*.view` |
| GET | `/suppliers/:id` · `/items/:id` | `*.view` |
| POST / PUT / DELETE | … | `*.create` / `*.edit` / `*.delete` |

The **`/profile`** endpoints are the auto-population contract of SRS §10 and §29:
selecting an item returns description, type, department, cost centre, groups, HSN,
UOM, specification, standard rate **and its live balances** (open indent quantity,
pending GRN quantity, last purchase rate) in a single call. Selecting a supplier
returns its full commercial profile.

---

## 4. Purchase Indent — `/indents`

| Method | Path | Permission |
|---|---|---|
| GET | `/indents` | `indent.view` |
| **GET** | **`/indents/eligible-lines`** | `po.create` |
| GET | `/indents/:id` | `indent.view` |
| POST | `/indents` | `indent.create` |
| PUT | `/indents/:id` | `indent.edit` |
| POST | `/indents/:id/submit` | `indent.create` |
| POST | `/indents/:id/approve` | `indent.approve` |
| POST | `/indents/:id/reject` | `indent.reject` — **reason required** |
| POST | `/indents/:id/cancel` | `indent.edit` — reason required |
| POST | `/indents/:id/reopen` | `indent.edit` |
| DELETE | `/indents/:id` | `indent.delete` — drafts only |

`/indents/eligible-lines` is what the PO builder consumes: approved indent lines with
`pending_qty > 0`, optionally restricted to one supplier's suggested indents for
supplier-wise consolidation.

The list response adds `meta.statusCounts` so the tab badges always agree with what
the list would show.

**Rules enforced:** no self-approval; a submitted indent must have lines; an approved
indent cannot be edited; an indent already converted into a PO cannot be cancelled.

---

## 5. Purchase Order — `/purchase-orders`

| Method | Path | Permission |
|---|---|---|
| GET | `/purchase-orders` | `po.view` — `?view=all\|pending\|complete` |
| GET | `/purchase-orders/:id` | `po.view` |
| POST | `/purchase-orders` | `po.create` |
| PUT | `/purchase-orders/:id` | `po.edit` — drafts only |
| POST | `/purchase-orders/:id/issue` | `po.approve` |
| POST | `/purchase-orders/:id/cancel` | `po.approve` — reason required |
| POST | `/purchase-orders/:id/short-close` | `po.approve` — reason required |
| POST | `/purchase-orders/calculate` | `po.view` — preview totals |
| DELETE | `/purchase-orders/:id` | `po.delete` — drafts only |

### Creating a purchase order

```jsonc
POST /purchase-orders
{
  "supplierId": 7,
  "poTypeId": 3,
  "issue": true,
  "lines": [
    {
      "itemId": 42, "poQty": "50", "rate": "250.00", "discountPct": "5",
      // Omit `sources` for a DIRECT PO.
      // One source = indent-based. Several = consolidated.
      "sources": [
        { "indentLineId": 118, "consumedQty": "30" },
        { "indentLineId": 205, "consumedQty": "20" }
      ]
    }
  ]
}
```

All four creation modes of SRS §11.1 are this one payload:

| Mode | Shape |
|---|---|
| Direct | no `sources` |
| Indent-based | one source |
| Multi-indent consolidation | several sources, different indents |
| Supplier-wise consolidation | sources selected via `eligible-lines?matchSupplier=true` |

**Rules enforced:** `Σ consumedQty` must equal `poQty` exactly (otherwise a quantity
would be untraceable); each draw is validated against the live eligible quantity
under `SELECT … FOR UPDATE`; the source indent must be approved and the item must
match; an issued PO cannot be edited; a PO with receipts cannot be cancelled (short
close instead).

`meta.totals` reports `value`, `received`, `pending` **excluding cancelled orders** —
the same definition as the `po_value_total` metric — plus `cancelledValue` separately.

---

## 6. GRN — `/grn`

| Method | Path | Permission |
|---|---|---|
| GET | `/grn` | `grn.view` |
| GET | `/grn/receivable-pos` | `grn.create` |
| GET | `/grn/po/:poId/lines` | `grn.create` |
| GET | `/grn/:id` | `grn.view` |
| POST | `/grn` | `grn.create` (`post: true` also needs `grn.approve`) |
| PUT | `/grn/:id` | `grn.edit` — drafts only |
| POST | `/grn/:id/post` | `grn.approve` |
| POST | `/grn/:id/cancel` | `grn.approve` — reason required |
| DELETE | `/grn/:id` | `grn.delete` — drafts only |

**Posting is what moves the balance.** A draft changes nothing. At post time every
line is re-validated against the live outstanding quantity, and the PO's status is
recomputed transactionally. Cancelling a posted GRN returns the quantity and
recomputes the status again.

---

## 7. Analytics — `/analytics`

| Method | Path | Permission |
|---|---|---|
| GET | `/analytics/metrics` | `dashboard.view` — the metric catalogue |
| GET | `/analytics/kpis` | `dashboard.view` |
| GET | `/analytics/trends` | analyze — `?granularity=day\|week\|month\|quarter\|year` |
| GET | `/analytics/breakdown/:dimension` | analyze |
| GET | `/analytics/ageing` | analyze — `?basis=po\|indent` |
| GET | `/analytics/supplier-performance` | analyze |
| GET | `/analytics/exceptions` | `dashboard.analyze` |
| GET | `/analytics/top-movers` | analyze |

Dimensions: `supplier`, `item`, `department`, `costCentre`, `mainGroup`,
`subMainGroup`, `itemType`, `poType`, `status` — resolved against a server-side
allow-list; anything else is a 422.

Every KPI is returned with its `formula`, `source`, `unit`, `inverse` flag and
`drilldown` target, straight from the metric catalogue (ADR-009). Every response
carries `meta.filters` and `meta.generatedAt` for filter context and data freshness
(SRS §38, §44).

---

## 8. Search, admin and operations

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/search?q=` | authenticated | Permission-aware, grouped by entity |
| GET/POST/PUT/DELETE | `/users` | `user.*` | Plus `/users/:id/reset-password`, `/users/:id/unlock` |
| GET/POST/PUT/DELETE | `/roles` | `role.*` | Plus `/roles/permissions` |
| GET | `/audit`, `/audit/facets`, `/audit/entity/:entity/:id`, `/audit/:id` | `audit.view` | Includes before/after values |
| GET/PUT | `/settings` | mixed | Branding is readable by all; the rest needs `system.admin` |
| GET/POST | `/backup` | `backup.view` / `backup.create` | Plus `/:id/verify`, `/:id/download`, `/:id/restore`, `DELETE /:id` |
| GET | `/io/export/:dataset?format=xlsx\|csv` | `*.export` | Filter-aware, branded, timestamped |
| POST | `/io/import/:entity/preview` | `*.import` | Upload → validate → preview |
| POST | `/io/import/:id/commit` | `*.import` | `STRICT` (default) or `PARTIAL` |
| GET | `/io/import/:id/errors.csv` | `*.import` | Downloadable error report |
| GET | `/io/import/template/:entity` | authenticated | Annotated Excel template |
| GET | `/google-sync/status` | `sync.view` | Drives the header toggle |
| POST | `/google-sync/toggle`, `/google-sync/run` | `sync.admin` | |
| GET | `/google-sync/jobs`, `/google-sync/issues` | `sync.view` | |
| POST | `/google-sync/issues/:id/resolve` | `sync.admin` | |
| GET | `/health` | — | Liveness plus database reachability and latency |

Only **master data** can be imported. Indents, purchase orders and GRNs must be
created through their workflows so numbering, approval and quantity controls apply.

---

## 9. Security notes

- Every route above carries a **server-side permission guard**. Frontend gating is
  ergonomic only.
- All SQL is parameterised; the sole interpolated identifiers are sort columns and
  analytics dimensions, both resolved against server-controlled allow-lists.
- `/auth/login` is rate-limited on **failed** attempts only, so a legitimate user is
  never penalised for signing in often; the other auth routes have a far more
  generous budget because an expired session naturally produces a burst of refreshes.
- Critical mutations write an audit record **inside the same transaction** as the
  change, so the trail can never claim something happened that was rolled back.

See [08_SECURITY.md](08_SECURITY.md).
