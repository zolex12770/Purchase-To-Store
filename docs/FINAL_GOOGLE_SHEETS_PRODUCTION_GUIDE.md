# Google Sheets — Production Guide

**Product:** ZOLEX Purchase-to-Store Enterprise ERP
**Company:** Zeeta Electrical Engineering Pvt. Ltd.
**Workbook:** `1Dyj3Ws9gyR2zOe6p6RafQrKUFyLKIFN5h-3XDe9KD9I`
**Last updated:** 25 August 2026

This is the operational reference for the people who maintain the spreadsheet.
Every header below is **copy-paste ready** and matches what the software actually
reads — the mappings live in `google_sheet_mappings` and are seeded from
`backend/src/db/seed.ts`.

---

## ⚠️ Read this first — a note on column definitions

Two different column sets were supplied for this workbook during the project
("Set A", SRS-aligned, and "Set B", a later business brief — see
`FINAL_GAP_AUDIT.md §4` for the original conflict). **Set B was the explicit
decision** once asked directly, so migration `007_sheet_set_b.sql` added the
database columns Set B needs (Item Master stock-planning fields, Supplier Pin
Code, GRN Accepted/Rejected Qty + Receipt Location), and the mappings below now
read Set B's headers.

**Both sets keep working.** Every Set A header that already existed is still
accepted as an alias — e.g. Item Master accepts `Item Description` **or**
`Item Name`, `Main Group` **or** `Category`. Nothing that was already syncing
under Set A headers breaks by switching the sheet to Set B headers, or vice
versa. The tables below list the current (Set B) primary header, with the Set A
alias noted where one exists.

---

## 1. Direction of travel

Sync is **one-way: Google Sheets → ZOLEX**. The software never writes to your
spreadsheet, so nothing you type there can be overwritten by the application.

| Sheet | Type | What sync does | Order |
|---|---|---|---|
| PO Type | Master | Creates/updates lookup values | 1st |
| Indent Type | Master | Creates/updates lookup values | 1st |
| Cost Center | Master | Creates/updates lookup values | 1st |
| User Master | Master | Creates/updates user records | 2nd |
| Supplier Master | Master | Creates/updates suppliers | 3rd |
| Item Master | Master | Creates/updates items | 4th |
| Purchase Indent | Transactional | **Reconciled only** — reports differences | 5th |
| Purchase Order | Transactional | **Reconciled only** — reports differences | 6th |
| GRN | Transactional | **Reconciled only** — reports differences | 7th |

**Masters are imported. Transactions are never silently imported over live
documents.** A purchase order that exists in ZOLEX is the authoritative record;
if the sheet disagrees, the difference is recorded as a conflict for a human to
resolve. This is deliberate — an approved PO is a commitment, and a spreadsheet
edit must not be able to alter it behind the approver's back.

The ordering matters: masters land before the transactions that reference them,
so an indent never fails because its cost centre had not been created yet.

---

## 2. Sheet-by-sheet reference

Rules that apply to every sheet:

- **Row 1 must be the header row.** Row 2 onwards is data.
- Header matching is **case-insensitive** and ignores surrounding spaces.
- Column **order does not matter** — columns are matched by name.
- An **empty row ends the sheet**. Do not leave blank rows in the middle.
- Extra columns you add for your own use are ignored, not rejected.
- Do not merge cells in the header row.

---

### 2.1 Item Master

**Purpose:** the catalogue every indent and purchase order draws from.
**Key column (identifies a row):** `Item Code`

Header row — copy this line into A1:

```
Item Code	Item Name	UOM	HSN Code	Category	Sub Category	Min Stock	Max Stock	Reorder Level	Reorder Qty	Is Active	Rate	GST Rate
```

`Item Type`, `Department`, `Indent Type`, `date`, `time` and `Item Specification`
are still accepted if present (Set A) — they simply are not required by Set B.

| Header | Required | Format | Valid values | Example |
|---|---|---|---|---|
| `Item Code` | **Yes** | Text, no leading/trailing spaces | Must be unique | `CBL-CU-3C25` |
| `Item Name` (alias: `Item Description`) | **Yes** | Text | — | `Copper armoured cable 3C x 25 sq mm` |
| `UOM` (alias: `Uom`) | No | Text | Must exist in UOM master | `Mtr` |
| `HSN Code` | No | 4–8 digits, text-formatted | — | `85444929` |
| `Category` (alias: `Main Group`) | No | Text | Auto-created if new | `Cables` |
| `Sub Category` (alias: `Sub Main Group`) | No | Text | Must belong to the Category above | `Armoured` |
| `Min Stock` | No | Number ≥ 0 | Blank leaves the existing value unchanged | `50` |
| `Max Stock` | No | Number ≥ 0 | Blank leaves the existing value unchanged | `500` |
| `Reorder Level` | No | Number ≥ 0 | Blank leaves the existing value unchanged | `100` |
| `Reorder Qty` | No | Number ≥ 0 | Quantity to raise on reorder | `200` |
| `Is Active` | No | `TRUE`/`FALSE`/`Yes`/`No`/`1`/`0` | Blank leaves the existing value unchanged | `TRUE` |
| `Rate` (alias: `Rate/pc`) | No | Number ≥ 0, up to 4 decimals | Defaults onto new PO lines | `425.5000` |
| `GST Rate` | No | Number 0–100 | Percent, not fraction | `18` |
| `Cost Centre` | No | Text | Must exist in **Cost Center** sheet | `CC-PLANT1` |
| `Indent Type` | No | Text | Must exist in **Indent Type** sheet | `Regular` |
| `Item Specification` | No | Text (long text is fine) | — | `1.1 kV grade, XLPE, IS 7098` |

> **Format HSN Code as Text** in Google Sheets (Format → Number → Plain text).
> Left as a number, `08544492` loses its leading zero.

**Common errors**

| Message | Cause | Fix |
|---|---|---|
| `Item Code is required` | Blank cell in a data row | Fill it, or delete the row |
| `Duplicate Item Code` | Same code twice in the sheet | Remove the duplicate |
| `Unknown Cost Centre 'X'` | Value not in the Cost Center sheet | Add it there first, then re-sync |
| `Unknown Sub Main Group` | Sub group not under the stated Main Group | Correct the pairing |

---

### 2.2 Supplier Master

**Purpose:** suppliers available on purchase orders.
**Key column:** `Supplier Code` when present, otherwise `Supplier Name`.

```
Supplier Code	Supplier Name	GST No	Contact Person	Phone	Email	Address	City	State	Pin Code	Is Active	Payment Terms
```

| Header | Required | Format | Example |
|---|---|---|---|
| `Supplier Code` | No | Text, unique | `SUP-0042` |
| `Supplier Name` | **Yes** | Text | `Polycab Wires Pvt Ltd` |
| `GST No` | No | 15 characters, GSTIN format | `27AABCU9603R1ZM` |
| `Contact Person` | No | Text | `Rakesh Sharma` |
| `Phone` (alias: `Mobile No.`) | No | Digits, `+`, spaces | `+91 9876543210` |
| `Email` (alias: `Gmail ID`) | No | Valid email address | `sales@example.com` |
| `Address` | No | Text | `Plot 14, MIDC Industrial Area` |
| `City` | No | Text | `Pune` |
| `State` | No | Text | `Maharashtra` |
| `Pin Code` | No | Text | `411019` |
| `Is Active` | No | `TRUE`/`FALSE`/`Yes`/`No`/`1`/`0` | `TRUE` |
| `Payment Terms` | No | Text | `30 days from invoice` |
| `Country` | No | Text (defaults to `India` if blank) | `India` |
| `Currency` | No | 3-letter ISO code (defaults `INR`) | `INR` |

> **Supplier Code as the key (Set B).** When the sheet supplies a `Supplier Code`,
> that is what a row is matched on — a rename in `Supplier Name` updates the same
> supplier rather than creating a new one. A sheet with no `Supplier Code` column
> keeps matching by `Supplier Name`, exactly as before, and the code is
> auto-generated (`SUP-####`).

**GSTIN format:** 2 digits (state) + 10 characters (PAN) + 1 + `Z` + 1.
A malformed GSTIN is reported as a validation error, not silently accepted.

---

### 2.3 User Master

**Purpose:** employee records. **Key column:** `Employee ID`

```
Employee Code	Full Name	Email	Department	Designation	Mobile
```

| Header | Required | Format | Example |
|---|---|---|---|
| `Employee Code` (alias: `Employee ID`) | **Yes** | Text, unique | `10221` |
| `Full Name` (alias: `Employee Name`) | **Yes** | Text | `System Administrator` |
| `Email` | No | Valid email address | `admin@zeeta.example` |
| `Department` | No | Text | Must exist in Department master |
| `Designation` | No | Text | `Purchase Head` |
| `Mobile` | No | Digits, `+`, spaces | `+91 9876543210` |

`Role` and `Is Active` from the Set B brief are **deliberately not synced**.
Account activation and role/permission grants stay decisions made inside ZOLEX
(**Admin → User Management**) — never set by a spreadsheet. A user arriving from
the sheet has no sign-in credential and no permissions until an administrator
grants them explicitly. This is intentional and unchanged from Set A.
>
> Employee IDs `10221` and `10422` are the bootstrap administrators. Sync will
> update their names and designations but can never deactivate or lock them out.

---

### 2.4 Cost Center

**Purpose:** cost centres used on indents, items and reporting.
**Key column:** `Cost Centre Name`

```
Cost Centre Code	Cost Centre Name	Is Active
```

| Header | Required | Example |
|---|---|---|
| `Cost Centre Code` | No | `CC-PLANT1` |
| `Cost Centre Name` (alias: `Cost Center`) | **Yes** | `Plant 1 — Winding` |
| `Is Active` | No | `TRUE` |

> **Naming note (ADR-006).** The original workbook used the header `Indent Type`
> on this sheet — a copy-paste error. The **canonical production header is
> `Cost Center`.** ZOLEX still accepts `Cost Centre` and the legacy `Indent Type`
> as aliases so an un-corrected sheet keeps working, but please correct the sheet
> to `Cost Center`: a sheet whose header says `Indent Type` while holding cost
> centres will mislead whoever maintains it next.

---

### 2.5 Indent Type

**Key column:** `Indent Type Name`

```
Indent Type Code	Indent Type Name	Is Active
```

| Header | Required | Example |
|---|---|---|
| `Indent Type Code` | No | `URG` |
| `Indent Type Name` (alias: `Indent Type`) | **Yes** | `Urgent` |
| `Is Active` | No | `TRUE` |

Suggested values: `Regular`, `Urgent`, `Capital`, `Project`, `Breakdown`.
These are yours to define — nothing in the software hard-codes them.

---

### 2.6 PO Type

**Key column:** `PO Type Name`

```
PO Type Code	PO Type Name	Is Active
```

| Header | Required | Example |
|---|---|---|
| `PO Type Code` | No | `REG` |
| `PO Type Name` (alias: `PO Type`) | **Yes** | `Regular` |
| `Is Active` | No | `TRUE` |

Suggested values: `Regular`, `Blanket`, `Capital`, `Service`, `Import`.

---

### 2.7 Purchase Indent  *(transactional — reconciled, never overwritten)*

**Key columns:** `Indent No` + `Item code` (one row per indent line)

```
Indent No	Indent Date	Indent Type	Cost Centre	Required By	Item Code	Quantity	UOM	Remarks	Priority
```

`date`/`time`, `Item Description`, `Item Specification` and `Department` are
still accepted if present (Set A).

| Header | Required | Format | Notes |
|---|---|---|---|
| `Indent No` | **Yes** | Text | Groups lines into one indent |
| `Indent Date` (alias: `date`) | No | `YYYY-MM-DD` | Indent date |
| `Indent Type` | No | Text | Must exist in Indent Type |
| `Cost Centre` | No | Text | Must exist in Cost Center |
| `Required By` | No | `YYYY-MM-DD` | Displayed for reconciliation only |
| `Item Code` (alias: `Item code`) | **Yes** | Text | Must exist in Item Master |
| `Quantity` (alias: `Indent Qty`) | **Yes** | Number > 0 | No thousands separators |
| `UOM` | No | Text | Must exist in UOM master |
| `Remarks` | No | Text | Displayed for reconciliation only |
| `Priority` | No | Text | Displayed for reconciliation only |
| `Live Qty` | **Leave blank** | — | **Calculated by ZOLEX** |
| `Pending GRN Qty` | **Leave blank** | — | **Calculated by ZOLEX** |

This sheet stays **read-only / reconciled** exactly as before — `Required By`,
`Remarks` and `Priority` are captured for the reconciliation report only, the
same as every other field on this sheet. Nothing here creates or edits an
indent; raise it through the Purchase Indent screen.

> **`Live Qty` and `Pending GRN Qty` are outputs, not inputs.** ZOLEX derives them
> from the actual purchase orders and goods receipts and ignores whatever the
> sheet contains. Anything typed there is not an error — it simply has no effect.
> They are listed here only because they exist in the source workbook.

---

### 2.8 Purchase Order  *(transactional — reconciled, never overwritten)*

**Key columns:** `Po no` + `Item code` (one row per PO line)

```
PO No	PO Date	Supplier Code	PO Type	Indent No (source)	Item Code	Quantity	Rate	Discount %	Delivery Date	Terms
```

`Indent type`/`Indent qty`, `time`, `Item Description`, `Final Rate/pc`/`Amount`
and `Item Specification` are still accepted if present (Set A).

| Header | Required | Format | Notes |
|---|---|---|---|
| `PO No` (alias: `Po no`) | **Yes** | Text | Groups lines into one PO |
| `PO Date` (alias: `date`) | No | `YYYY-MM-DD` | |
| `Supplier Code` | No | Text | Displayed for reconciliation only |
| `PO Type` (alias: `Po type`) | No | Text | Must exist in PO Type |
| `Indent No (source)` (alias: `Indent No`) | No | Text | Source indent, if the PO came from one |
| `Item Code` (alias: `Item code`) | **Yes** | Text | Must exist in Item Master |
| `Quantity` (alias: `Po qty`) | **Yes** | Number > 0 | |
| `Rate` (alias: `Rate/pc`) | No | Number ≥ 0 | Up to 4 decimal places |
| `Discount %` | No | Number 0–100 | Enter `12.5`, **not** `0.125` |
| `Delivery Date` | No | `YYYY-MM-DD` | Displayed for reconciliation only |
| `Terms` | No | Text | Displayed for reconciliation only |
| `Final Rate/pc` | **Leave blank** | — | **Calculated by ZOLEX** |
| `Amount` | **Leave blank** | — | **Calculated by ZOLEX** |

> **`Final Rate/pc` and `Amount` are computed by the database**, as
> `Final Rate = Rate × (1 − Discount% ÷ 100)` and `Amount = PO Qty × Final Rate`,
> rounded to 4 and 2 decimals respectively. They are generated columns, so they
> cannot drift from their inputs and cannot be overridden from a sheet, an API
> call or the UI. If the sheet's figure disagrees with the computed one, the
> difference is reported as a conflict — that is a feature, not a fault.

**Supplier column.** ZOLEX accepts `Supplier Code`, or `Supplier`/`Supplier
Name` (Set A), matching the Supplier Master. Reconciliation itself still checks
only quantity and rate — the supplier field is displayed, not diffed.

---

### 2.9 GRN  *(transactional — reconciled, never overwritten)*

**Key columns:** `Po no` + `Item code` + `date`

```
GRN No	GRN Date	PO No	Item Code	Received Qty	Accepted Qty	Rejected Qty	Receipt Location	Remarks
```

`Po type`, `Item description` and `time` are still accepted if present (Set A).

| Header | Required | Format | Notes |
|---|---|---|---|
| `GRN No` | No | Text | Informational — GRN numbers are issued by ZOLEX |
| `GRN Date` (alias: `date`) | No | `YYYY-MM-DD` | |
| `PO No` (alias: `Po no`) | **Yes** | Text | Must match an existing PO |
| `Item Code` (alias: `Item code`) | **Yes** | Text | Must be a line on that PO |
| `Received Qty` (alias: `Grn qty`) | **Yes** | Number > 0 | Cannot exceed the PO's outstanding quantity |
| `Accepted Qty` | No | Number ≥ 0 | Displayed for reconciliation only |
| `Rejected Qty` | No | Number ≥ 0 | Displayed for reconciliation only |
| `Receipt Location` | No | Text | Displayed for reconciliation only |
| `Remarks` | No | Text | Displayed for reconciliation only |
| `Pending GRN qty` | **Leave blank** | — | **Calculated by ZOLEX** |

> Over-receipt is refused, in the sheet exactly as in the UI. A GRN quantity
> greater than the PO's outstanding balance is reported with the arithmetic
> shown, and no partial receipt is written.
>
> **`Received Qty` keeps its existing meaning everywhere it already drives stock
> and pending-PO balances.** `Accepted Qty` / `Rejected Qty` / `Receipt Location`
> are additional detail shown in the reconciliation report — this sheet stays
> read-only, so an accepted/rejected split typed in the sheet does not itself
> create or alter a GRN. To record a real accepted/rejected split, use the
> **Rejected Qty** field on the GRN screen when receiving — Accepted Qty is then
> computed automatically as Received Qty minus Rejected Qty.

---

## 3. Data format rules (all sheets)

| Field type | Accepted | Rejected | Why |
|---|---|---|---|
| **Date** | `2026-04-12`, `12/04/2026`, `12-Apr-2026` | `12.4.26`, `April` | Ambiguous or unparseable |
| **Time** | `14:35`, `14:35:00`, `2:35 PM` | `1435` | Not a time |
| **Quantity** | `150`, `150.5`, `150.2500` | `1,50`, `150 nos`, `-5` | Separators, units, negatives |
| **Rate / currency** | `1250`, `1250.75`, `1250.7500` | `₹1250`, `1,250.75` | Symbols and separators |
| **Discount %** | `0`, `12.5`, `100` | `12.5%`, `0.125`, `120` | Percent sign; fraction; out of range |
| **GSTIN** | `27AABCU9603R1ZM` | `27AABCU9603R1Z` | Must be exactly 15 characters |
| **Mobile** | `+91 9876543210`, `9876543210` | `98765 ABC` | Digits, `+` and spaces only |
| **Email** | `sales@example.com` | `sales@`, `sales.example.com` | Must be a valid address |
| **Boolean** | `TRUE`, `FALSE`, `Yes`, `No`, `1`, `0` | `Y`, `N` | Ambiguous |

**Set numeric columns to plain number format**, not Currency or Accounting.
Google's currency formatting inserts symbols and separators into the exported
value, which then fail validation.

---

## 4. Service account setup

A private spreadsheet cannot be read with an API key. It needs a **service
account** — a machine identity you explicitly share the sheet with.

### 4.1 Create the credential

1. Open the **Google Cloud Console** → <https://console.cloud.google.com>
2. Create a project (or select an existing one), e.g. `zolex-erp`.
3. **APIs & Services → Library** → search **Google Sheets API** → **Enable**.
4. **APIs & Services → Credentials → Create credentials → Service account**.
   - Name: `zolex-sheets-reader`
   - Role: **none required** — access comes from sharing the sheet, not from IAM.
5. Open the new service account → **Keys → Add key → Create new key → JSON**.
6. A `.json` file downloads. **This file is a credential. Treat it as a password.**

### 4.2 Store the key safely

Put it **outside the repository**, readable only by the account that runs ZOLEX:

```
C:\Users\<user>\ZolexERP\secrets\zolex-sheets.json      (Windows)
/var/lib/zolex/secrets/zolex-sheets.json                 (Linux)
```

```bash
# Linux — owner-only
sudo chown zolex:zolex /var/lib/zolex/secrets/zolex-sheets.json
sudo chmod 600 /var/lib/zolex/secrets/zolex-sheets.json
```

**Never commit it to Git.** `.gitignore` already excludes `*.json` under the data
root and `secrets/`, but the safest rule is simply: the key never enters the
project folder.

### 4.3 Share the spreadsheet with the service account

1. Open the JSON key and copy `client_email` — it looks like
   `zolex-sheets-reader@zolex-erp.iam.gserviceaccount.com`.
2. Open the spreadsheet → **Share** → paste that address.
3. Give it **Viewer**. Read-only is all ZOLEX needs, and it makes it impossible
   for the software to alter your workbook even if asked to.
4. Untick "Notify people" and click **Share**.

### 4.4 Configure ZOLEX

In `backend/.env`:

```ini
GOOGLE_SHEET_ID=1Dyj3Ws9gyR2zOe6p6RafQrKUFyLKIFN5h-3XDe9KD9I
GOOGLE_SERVICE_ACCOUNT_KEY_FILE=C:\Users\<user>\ZolexERP\secrets\zolex-sheets.json
GOOGLE_SYNC_INTERVAL_MINUTES=60
```

Restart the backend. Then, in the application:

1. **Admin → Google Sheets Sync** — the status panel should show *Configured*.
2. Press **Dry run** first. It reads and validates and **writes nothing**.
3. Read the report. Fix any errors in the sheet.
4. Only then use **Sync now**.
5. Turn on **LIVE SYNC** in the header when you want it to run on the interval.

---

## 5. The LIVE SYNC toggle

The switch in the application header is the master control.

| State | Behaviour |
|---|---|
| **ON** | Scheduled sync runs on the configured interval; manual sync allowed; status, last/next run, errors and conflict counts are shown |
| **OFF** | **No** scheduled sync, **no** background reads or writes; the UI states plainly that sync is disabled |

The setting is stored in the database, not in the browser — it survives a
restart and applies to everyone, not just the person who set it.

---

## 6. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Google Sheets is not configured` | No key file path set | Set `GOOGLE_SERVICE_ACCOUNT_KEY_FILE`, restart |
| `Credential file not found` | Wrong path, or unreadable by the service user | Check the path and file permissions |
| `403 — caller does not have permission` | Sheet not shared with the service account | Share it with `client_email` as Viewer |
| `404 — requested entity was not found` | Wrong `GOOGLE_SHEET_ID` | Copy the ID from the URL between `/d/` and `/edit` |
| `Sheet 'X' not found` | Tab renamed or deleted | Restore the exact tab name (case-sensitive) |
| `Required header 'X' missing` | Header renamed, or not in row 1 | Restore the header exactly as in this guide |
| `Unknown lookup value 'X'` | Referenced master value does not exist | Add it to its master sheet and re-sync (masters sync first) |
| `Row skipped: conflict` | Sheet disagrees with a live ZOLEX document | Open the conflict list and resolve it — by design nothing is overwritten |
| `429 — quota exceeded` | Sync interval too aggressive | Raise `GOOGLE_SYNC_INTERVAL_MINUTES` (60 is ample) |
| Sync never runs | LIVE SYNC is off | Turn it on in the header |

**Where to look:** *Admin → Google Sheets Sync* shows every run with its row
counts, errors and conflicts. Nothing fails silently.

---

## 7. Current verification status — stated plainly

| Capability | Status |
|---|---|
| ON/OFF toggle, persisted, survives restart | ✅ Verified |
| All 9 sheet mappings present and correct | ✅ Verified |
| Header aliases (incl. the `Cost Center` defect) | ✅ Verified |
| Masters-first ordering | ✅ Verified |
| Conflict recording; approved documents never overwritten | ✅ Verified |
| Job history, error list, scheduler | ✅ Verified |
| Clean degradation when no credential is present | ✅ Verified |
| **Authenticated read of the live spreadsheet** | ⚠️ **NOT VERIFIED** |

The last line is not verified because **no Google service-account credential
exists in this environment**, and it cannot be verified without one. It is
reported as PARTIAL rather than rounded up to a pass.

To close it: follow §4, then run **Dry run** and confirm the row counts match
your sheet.
