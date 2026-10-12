/**
 * Google Sheets synchronisation engine (SRS §8, §9; ADR-006, ADR-007).
 *
 * Design constraints taken directly from the specification:
 *
 *  • SQL is the system of record. Sync is ONE-WAY, Sheets → SQL.
 *  • Sync must NEVER silently overwrite protected/approved transactional records.
 *    Master data is upserted; transactional documents that have left DRAFT are
 *    never touched — a divergence is recorded as a CONFLICT for an administrator.
 *  • Sheet columns are mapped declaratively with header ALIASES, so the
 *    `Cost Center` sheet's mis-named header (SRS §9/§44) is absorbed by data, not
 *    by a special case in this file.
 *  • Every run produces status, timings, row counts, validation errors and audit.
 *  • Derived values in the sheet (Live Qty, Pending GRN Qty, Final Rate, Amount)
 *    are NEVER imported — they are computed here (ADR-004, ADR-005).
 */
import { query, queryOne, withTransaction, txQuery, txQueryOne } from '../../db/index.js';
import { env } from '../../config/env.js';
import { logger } from '../../core/logger.js';
import { audit, SYSTEM_ACTOR } from '../../core/audit.js';
import { IntegrationError } from '../../core/errors.js';
import { parseNumericInput } from '../../domain/money.js';
/* ── Configuration state ────────────────────────────────────────────────────── */
export async function isSyncEnabled() {
    const row = await queryOne("SELECT value FROM app_settings WHERE key = 'google_sync.enabled'");
    return row?.value === true || row?.value === 'true';
}
export async function setSyncEnabled(enabled, actor) {
    await query(`UPDATE app_settings SET value = $1::jsonb, updated_at = now(), updated_by = $2
      WHERE key = 'google_sync.enabled'`, [JSON.stringify(enabled), actor.userId ?? null]);
    await audit({
        actor, action: 'SYNC_TOGGLE', entity: 'google_sync', entityLabel: 'Live Sync',
        after: { enabled },
        message: enabled
            ? 'Google Sheets Live Sync switched ON.'
            : 'Google Sheets Live Sync switched OFF — the ERP continues on its own database.',
    });
}
/**
 * Reports whether credentials exist WITHOUT throwing.
 * Absent credentials must degrade to a clear "not configured" state, never a crash
 * (SRS §8 — the ERP has to keep working with sync off).
 */
export function syncConfig() {
    const sheetId = env.GOOGLE_SHEET_ID;
    if (env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE && env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE.trim()) {
        return { configured: true, mode: 'service-account', sheetId };
    }
    if (env.GOOGLE_API_KEY && env.GOOGLE_API_KEY.trim()) {
        return { configured: true, mode: 'api-key', sheetId };
    }
    return {
        configured: false, mode: 'none', sheetId,
        reason: 'No Google credentials configured. Set GOOGLE_SERVICE_ACCOUNT_KEY_FILE (recommended) or ' +
            'GOOGLE_API_KEY in backend/.env. The ERP operates normally from its own database with sync off.',
    };
}
/* ── Sheet reading ──────────────────────────────────────────────────────────── */
/** Exported for the DATABASE/GOOGLE_SHEET archive export (admin/export.routes.ts) — same read path the sync engine itself uses, so the archive is never a second implementation. */
export async function readSheet(sheetName) {
    const cfg = syncConfig();
    if (!cfg.configured) {
        throw IntegrationError(cfg.reason ?? 'Google Sheets is not configured.');
    }
    const { google } = await import('googleapis');
    let auth;
    if (cfg.mode === 'service-account') {
        const { GoogleAuth } = await import('google-auth-library');
        auth = new GoogleAuth({
            keyFile: env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE,
            scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
        });
    }
    const sheets = google.sheets({
        version: 'v4',
        ...(cfg.mode === 'api-key' ? { auth: env.GOOGLE_API_KEY } : { auth: auth }),
    });
    try {
        const res = await sheets.spreadsheets.values.get({
            spreadsheetId: cfg.sheetId,
            range: `${sheetName}!A1:ZZ`,
            valueRenderOption: 'UNFORMATTED_VALUE',
            dateTimeRenderOption: 'FORMATTED_STRING',
        });
        return (res.data.values ?? []).map((row) => (row ?? []).map((c) => (c === null || c === undefined ? '' : String(c).trim())));
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (/not found|Unable to parse range/i.test(message)) {
            throw IntegrationError(`Sheet "${sheetName}" was not found in the configured spreadsheet.`);
        }
        if (/permission|forbidden|403/i.test(message)) {
            throw IntegrationError(`Access to the spreadsheet was denied. Share it with the service account, or make it link-viewable when using an API key.`);
        }
        throw IntegrationError(`Could not read sheet "${sheetName}": ${message}`);
    }
}
/** Resolves a field's column index using its header aliases (ADR-006). */
function resolveColumns(headerRow, columns) {
    const normalised = new Map();
    headerRow.forEach((h, i) => {
        const key = h.toLowerCase().trim();
        if (key && !normalised.has(key))
            normalised.set(key, i);
    });
    const map = new Map();
    for (const col of columns) {
        for (const alias of col.headers) {
            const idx = normalised.get(alias.toLowerCase().trim());
            if (idx !== undefined) {
                map.set(col.field, idx);
                break;
            }
        }
    }
    return map;
}
async function recordErrors(tx, jobId, errors) {
    for (const e of errors) {
        await tx.query(`INSERT INTO google_sync_errors
         (job_id, sheet_name, row_number, column_name, business_key, severity,
          error_code, error_message, raw_value, existing_value, incoming_value)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb)`, [
            jobId, e.sheet, e.row, e.column, e.businessKey, e.severity, e.code, e.message,
            e.rawValue ?? null,
            e.existing === undefined ? null : JSON.stringify(e.existing),
            e.incoming === undefined ? null : JSON.stringify(e.incoming),
        ]);
    }
}
async function loadLookupIndex(tx) {
    const rows = await txQuery(tx, 'SELECT id, category, code, name FROM lookups WHERE deleted_at IS NULL');
    const idx = new Map();
    for (const r of rows) {
        idx.set(`${r.category}:${r.name.toLowerCase().trim()}`, Number(r.id));
        idx.set(`${r.category}:${r.code.toLowerCase().trim()}`, Number(r.id));
    }
    return idx;
}
/**
 * Ensures a lookup value exists, creating it if the sheet introduces a new one.
 *
 * This is deliberate: the sheets ARE the migration source for PO Type, Indent Type
 * and Cost Centre (SRS §9), so an unseen value is new master data, not an error.
 * Auto-created rows are tagged so an administrator can review what sync introduced.
 */
async function ensureLookup(tx, idx, category, value) {
    const clean = value.trim();
    if (!clean)
        return null;
    const hit = idx.get(`${category}:${clean.toLowerCase()}`);
    if (hit !== undefined)
        return hit;
    const code = clean.toUpperCase().replace(/[^A-Z0-9]+/g, '_').slice(0, 40) || 'VALUE';
    const created = await txQueryOne(tx, `INSERT INTO lookups (category, code, name, extra)
     VALUES ($1,$2,$3,'{"seed":"google-sync"}'::jsonb)
     ON CONFLICT (category, upper(code)) WHERE deleted_at IS NULL DO NOTHING
     RETURNING id`, [category, code, clean]);
    if (created) {
        idx.set(`${category}:${clean.toLowerCase()}`, Number(created.id));
        idx.set(`${category}:${code.toLowerCase()}`, Number(created.id));
        return Number(created.id);
    }
    // Lost the race, or the code collided with a different name — read it back.
    const existing = await txQueryOne(tx, 'SELECT id FROM lookups WHERE category = $1 AND upper(code) = upper($2) AND deleted_at IS NULL', [category, code]);
    if (existing) {
        idx.set(`${category}:${clean.toLowerCase()}`, Number(existing.id));
        return Number(existing.id);
    }
    return null;
}
/** Simple lookup-category masters: PO Type, Indent Type, Cost Centre. */
async function syncLookupSheet(ctx, category) {
    const name = (ctx.values.name ?? '').trim();
    if (!name) {
        ctx.outcome.skipped += 1;
        return;
    }
    const before = ctx.lookups.get(`${category}:${name.toLowerCase()}`);
    const id = await ensureLookup(ctx.tx, ctx.lookups, category, name);
    if (id === null) {
        ctx.outcome.rejected += 1;
        ctx.errors.push({
            sheet: ctx.sheet, row: ctx.rowNumber, column: 'name', businessKey: name,
            severity: 'ERROR', code: 'LOOKUP_CREATE_FAILED',
            message: `Could not create the ${category.replace(/_/g, ' ').toLowerCase()} value "${name}".`,
        });
        return;
    }
    // Set B optionally supplies an explicit code and an Is Active flag for these
    // masters (Cost Centre / Indent Type / PO Type). Applied on top of whatever
    // ensureLookup() just resolved/created — never overwrites `name` itself,
    // which stays the sheet's own row identity.
    const explicitCode = (ctx.values.code ?? '').trim();
    const activeRaw = (ctx.values.is_active ?? '').trim();
    if (explicitCode || activeRaw) {
        const isActive = activeRaw ? isTruthyFlag(activeRaw) : null;
        await ctx.tx.query(`UPDATE lookups
          SET code = CASE WHEN $2 <> '' THEN $2 ELSE code END,
              is_active = COALESCE($3, is_active),
              updated_at = now()
        WHERE id = $1
          AND (code, is_active) IS DISTINCT FROM
              (CASE WHEN $2::text <> '' THEN $2::text ELSE code END,
               COALESCE($3::boolean, is_active))`, [id, explicitCode, isActive]);
    }
    if (before === undefined)
        ctx.outcome.inserted += 1;
    else
        ctx.outcome.skipped += 1;
}
/**
 * Machine-Machine sheet -> MACHINE lookups, cascading from DEPARTMENT
 * (migration 015 / lookup.routes.ts's PARENT_OF['MACHINE'] = 'DEPARTMENT').
 *
 * Unlike PO Type / Indent Type / Cost Centre, the parent Department is NOT
 * auto-created here — a machine sheet is not the migration source for the
 * Department master, and silently inventing a department from a typo would
 * misfile real equipment. An unresolvable Department is rejected with a
 * clear, row-specific error instead.
 */
async function syncMachineSheet(ctx) {
    const machineNo = (ctx.values.machine_no ?? '').trim();
    const departmentName = (ctx.values.department ?? '').trim();
    if (!machineNo) {
        ctx.outcome.skipped += 1;
        return;
    }
    if (!departmentName) {
        ctx.outcome.rejected += 1;
        ctx.errors.push({
            sheet: ctx.sheet, row: ctx.rowNumber, column: 'Department', businessKey: machineNo,
            severity: 'ERROR', code: 'REQUIRED_FIELD_MISSING',
            message: `Machine ${machineNo} has no Department in the sheet.`,
        });
        return;
    }
    const departmentId = ctx.lookups.get(`DEPARTMENT:${departmentName.toLowerCase()}`);
    if (departmentId === undefined) {
        ctx.outcome.rejected += 1;
        ctx.errors.push({
            sheet: ctx.sheet, row: ctx.rowNumber, column: 'Department', businessKey: machineNo,
            severity: 'ERROR', code: 'DEPARTMENT_NOT_FOUND',
            message: `Machine ${machineNo}: department "${departmentName}" does not exist in the ERP. Create it in Supporting Masters first — a machine sheet does not create departments.`,
            incoming: { machineNo, departmentName },
        });
        return;
    }
    const before = ctx.lookups.get(`MACHINE:${machineNo.toLowerCase()}`);
    const code = machineNo.toUpperCase().replace(/[^A-Z0-9-]+/g, '_').slice(0, 40) || 'MACHINE';
    const upserted = await txQueryOne(ctx.tx, `INSERT INTO lookups (category, code, name, parent_id, extra)
     VALUES ('MACHINE',$1,$2,$3,'{"seed":"google-sync"}'::jsonb)
     ON CONFLICT (category, upper(code)) WHERE deleted_at IS NULL
       DO UPDATE SET name = EXCLUDED.name, parent_id = EXCLUDED.parent_id, updated_at = now()
     RETURNING id`, [code, machineNo, departmentId]);
    if (!upserted) {
        ctx.outcome.rejected += 1;
        ctx.errors.push({
            sheet: ctx.sheet, row: ctx.rowNumber, column: 'Machine No', businessKey: machineNo,
            severity: 'ERROR', code: 'LOOKUP_CREATE_FAILED',
            message: `Could not create or update machine "${machineNo}".`,
        });
        return;
    }
    ctx.lookups.set(`MACHINE:${machineNo.toLowerCase()}`, Number(upserted.id));
    ctx.lookups.set(`MACHINE:${code.toLowerCase()}`, Number(upserted.id));
    if (before === undefined)
        ctx.outcome.inserted += 1;
    else
        ctx.outcome.updated += 1;
}
/** Parses a sheet "Is Active"-style flag. Blank stays unspecified (returns null upstream). */
function isTruthyFlag(raw) {
    const v = raw.trim().toLowerCase();
    return v === 'true' || v === 'yes' || v === 'y' || v === '1' || v === 'active';
}
async function syncSupplierRow(ctx) {
    const name = (ctx.values.supplier_name ?? '').trim();
    if (!name) {
        ctx.outcome.rejected += 1;
        ctx.errors.push({
            sheet: ctx.sheet, row: ctx.rowNumber, column: 'Supplier Name', businessKey: null,
            severity: 'ERROR', code: 'REQUIRED', message: 'Supplier Name is required.',
        });
        return;
    }
    // Set B supplies Supplier Code as the sheet's own key. When present it takes
    // priority for matching (two suppliers can share a name); a sheet without a
    // code keeps matching by name exactly as before (Set A behaviour, unchanged).
    const sheetCode = (ctx.values.supplier_code ?? '').trim();
    const existing = sheetCode
        ? await txQueryOne(ctx.tx, 'SELECT id, supplier_code FROM suppliers WHERE upper(supplier_code) = upper($1) AND deleted_at IS NULL', [sheetCode])
        : await txQueryOne(ctx.tx, 'SELECT id, supplier_code FROM suppliers WHERE lower(supplier_name) = lower($1) AND deleted_at IS NULL', [name]);
    const activeRaw = (ctx.values.is_active ?? '').trim();
    const fields = {
        address: ctx.values.address ?? '',
        state: ctx.values.state ?? '',
        city: ctx.values.city ?? '',
        country: ctx.values.country || 'India',
        mobile_no: ctx.values.mobile_no ?? '',
        email: ctx.values.email ?? '',
        gst_no: (ctx.values.gst_no ?? '').toUpperCase(),
        payment_terms: ctx.values.payment_terms ?? '',
        currency_code: ctx.values.currency_code || 'INR',
        contact_person: ctx.values.contact_person ?? '',
        pin_code: ctx.values.pin_code ?? '',
        is_active: activeRaw ? isTruthyFlag(activeRaw) : null,
    };
    if (existing) {
        // Unchanged rows are not rewritten -- see the note on the item sync above.
        const res = await ctx.tx.query(`UPDATE suppliers
          SET supplier_name = $2, address = $3, state = $4, city = $5, country = $6, mobile_no = $7,
              email = $8, gst_no = $9, payment_terms = $10, currency_code = $11,
              contact_person = $12, pin_code = $13, is_active = COALESCE($14, is_active),
              updated_at = now()
        WHERE id = $1
          AND (supplier_name, address, state, city, country, mobile_no, email, gst_no,
               payment_terms, currency_code, contact_person, pin_code, is_active)
              IS DISTINCT FROM
              ($2::text, $3::text, $4::text, $5::text, $6::text, $7::text, $8::text, $9::text,
               $10::text, $11::text, $12::text, $13::text, COALESCE($14::boolean, is_active))`, [existing.id, name, fields.address, fields.state, fields.city, fields.country,
            fields.mobile_no, fields.email, fields.gst_no, fields.payment_terms, fields.currency_code,
            fields.contact_person, fields.pin_code, fields.is_active]);
        if (res.rowCount > 0)
            ctx.outcome.updated += 1;
        else
            ctx.outcome.skipped += 1;
        return;
    }
    let code = sheetCode;
    if (!code) {
        const codeRow = await txQueryOne(ctx.tx, `SELECT MAX(CAST(substring(supplier_code FROM 'SUP-([0-9]+)$') AS INTEGER)) AS max_num
         FROM suppliers WHERE supplier_code ~ '^SUP-[0-9]+$'`);
        code = `SUP-${String(Number(codeRow?.max_num ?? 0) + 1).padStart(4, '0')}`;
    }
    await ctx.tx.query(`INSERT INTO suppliers (supplier_code, supplier_name, address, state, city, country,
                            mobile_no, email, gst_no, payment_terms, currency_code,
                            contact_person, pin_code, is_active, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'Imported from Google Sheets')`, [code, name, fields.address, fields.state, fields.city, fields.country,
        fields.mobile_no, fields.email, fields.gst_no, fields.payment_terms, fields.currency_code,
        fields.contact_person, fields.pin_code, fields.is_active ?? true]);
    ctx.outcome.inserted += 1;
}
async function syncItemRow(ctx) {
    const code = (ctx.values.item_code ?? '').trim();
    const description = (ctx.values.item_description ?? '').trim();
    if (!code || !description) {
        ctx.outcome.rejected += 1;
        ctx.errors.push({
            sheet: ctx.sheet, row: ctx.rowNumber,
            column: !code ? 'Item Code' : 'Item Description', businessKey: code || null,
            severity: 'ERROR', code: 'REQUIRED',
            message: !code ? 'Item Code is required.' : `Item ${code} has no description.`,
        });
        return;
    }
    const L = async (category, field) => ensureLookup(ctx.tx, ctx.lookups, category, ctx.values[field] ?? '');
    const [itemType, department, costCentre, mainGroup, subGroup, indentType, uom] = await Promise.all([
        L('ITEM_TYPE', 'item_type'), L('DEPARTMENT', 'department'), L('COST_CENTRE', 'cost_centre'),
        L('MAIN_GROUP', 'main_group'), L('SUB_MAIN_GROUP', 'sub_main_group'),
        L('INDENT_TYPE', 'indent_type'), L('UOM', 'uom'),
    ]);
    const existing = await txQueryOne(ctx.tx, 'SELECT id FROM items WHERE upper(item_code) = upper($1) AND deleted_at IS NULL', [code]);
    // Set B stock-planning fields. Blank cells leave the existing value alone on
    // update (COALESCE) so a partially-filled sheet can't erase what an
    // administrator already set through the UI; on insert a blank is just NULL.
    const minStock = parseNumericInput(ctx.values.min_stock);
    const maxStock = parseNumericInput(ctx.values.max_stock);
    const reorderLevel = parseNumericInput(ctx.values.reorder_level);
    const reorderQty = parseNumericInput(ctx.values.reorder_qty);
    const standardRate = parseNumericInput(ctx.values.standard_rate);
    const gstRate = parseNumericInput(ctx.values.gst_rate);
    const activeRaw = (ctx.values.is_active ?? '').trim();
    const isActive = activeRaw ? isTruthyFlag(activeRaw) : null;
    const params = [
        description, itemType, department, costCentre, mainGroup, subGroup,
        indentType, uom, ctx.values.hsn_code ?? '', ctx.values.item_specification ?? '',
        minStock, maxStock, reorderLevel, reorderQty, standardRate, gstRate,
    ];
    if (existing) {
        // Compare before writing.
        //
        // This statement used to run unconditionally for every row of the master
        // sheet, and `updated_at = now()` made every one of them a real UPDATE even
        // when nothing had changed: 12,461 item writes every 15 minutes on an
        // otherwise idle system. Measured on the live database, that left 14,477
        // queued replica changes, not one of which represented an edit anybody had
        // made -- and processing them is what stalled the ERP.
        //
        // An unchanged row now costs nothing: no write, no trigger, no queued
        // change. `rowCount` also makes the reported "updated" figure truthful.
        const res = await ctx.tx.query(`UPDATE items
          SET item_description = $2, item_type_id = $3, department_id = $4, cost_centre_id = $5,
              main_group_id = $6, sub_main_group_id = $7, indent_type_id = $8, uom_id = $9,
              hsn_code = $10, item_specification = $11,
              min_stock = COALESCE($12, min_stock), max_stock = COALESCE($13, max_stock),
              reorder_level = COALESCE($14, reorder_level), reorder_qty = COALESCE($15, reorder_qty),
              standard_rate = COALESCE($16, standard_rate), gst_rate = COALESCE($17, gst_rate),
              is_active = COALESCE($18, is_active),
              updated_at = now()
        WHERE id = $1
          AND (item_description, item_type_id, department_id, cost_centre_id, main_group_id,
               sub_main_group_id, indent_type_id, uom_id, hsn_code, item_specification,
               min_stock, max_stock, reorder_level, reorder_qty, standard_rate, gst_rate, is_active)
              IS DISTINCT FROM
              ($2::text, $3::bigint, $4::bigint, $5::bigint, $6::bigint,
               $7::bigint, $8::bigint, $9::bigint, $10::text, $11::text,
               COALESCE($12::numeric, min_stock), COALESCE($13::numeric, max_stock),
               COALESCE($14::numeric, reorder_level), COALESCE($15::numeric, reorder_qty),
               COALESCE($16::numeric, standard_rate), COALESCE($17::numeric, gst_rate),
               COALESCE($18::boolean, is_active))`, [existing.id, ...params, isActive]);
        if (res.rowCount > 0)
            ctx.outcome.updated += 1;
        else
            ctx.outcome.skipped += 1;
    }
    else {
        await ctx.tx.query(`INSERT INTO items (item_code, item_description, item_type_id, department_id, cost_centre_id,
                          main_group_id, sub_main_group_id, indent_type_id, uom_id, hsn_code,
                          item_specification, min_stock, max_stock, reorder_level, reorder_qty,
                          standard_rate, gst_rate, is_active, source_date, source_time)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`, [code, ...params, isActive ?? true,
            ctx.values.source_date && /^\d{4}-\d{2}-\d{2}$/.test(ctx.values.source_date) ? ctx.values.source_date : null,
            ctx.values.source_time ?? '']);
        ctx.outcome.inserted += 1;
    }
}
async function syncUserRow(ctx) {
    const employeeId = (ctx.values.employee_id ?? '').trim();
    const name = (ctx.values.employee_name ?? '').trim();
    if (!employeeId || !name) {
        ctx.outcome.rejected += 1;
        ctx.errors.push({
            sheet: ctx.sheet, row: ctx.rowNumber,
            column: !employeeId ? 'Employee ID' : 'Employee Name', businessKey: employeeId || null,
            severity: 'ERROR', code: 'REQUIRED', message: 'Employee ID and Employee Name are both required.',
        });
        return;
    }
    const existing = await txQueryOne(ctx.tx, 'SELECT id FROM users WHERE employee_id = $1 AND deleted_at IS NULL', [employeeId]);
    // Set B adds Email / Department / Mobile to the synced profile fields.
    // Role and Is Active are still deliberately NOT synced — account activation
    // and role grants stay ERP-owned security decisions, never set by a
    // spreadsheet (unchanged from Set A; see the INSERT below).
    const department = await ensureLookup(ctx.tx, ctx.lookups, 'DEPARTMENT', ctx.values.department ?? '');
    if (existing) {
        // Unchanged rows are not rewritten -- see the note on the item sync above.
        const res = await ctx.tx.query(`UPDATE users
          SET employee_name = $2, designation = $3, email = COALESCE(NULLIF($4, ''), email),
              mobile_no = COALESCE(NULLIF($5, ''), mobile_no), department_id = COALESCE($6, department_id),
              updated_at = now()
        WHERE id = $1
          AND (employee_name, designation, email, mobile_no, department_id)
              IS DISTINCT FROM
              ($2::text, $3::text, COALESCE(NULLIF($4::text, ''), email),
               COALESCE(NULLIF($5::text, ''), mobile_no), COALESCE($6::bigint, department_id))`, [existing.id, name, ctx.values.designation ?? '', ctx.values.email ?? '', ctx.values.mobile_no ?? '', department]);
        if (res.rowCount > 0)
            ctx.outcome.updated += 1;
        else
            ctx.outcome.skipped += 1;
        return;
    }
    // New users arrive INACTIVE with an unusable password hash. An administrator
    // must activate them and set a password — a spreadsheet must never be able to
    // create a usable login.
    const created = await txQueryOne(ctx.tx, `INSERT INTO users (employee_id, employee_name, designation, email, mobile_no, department_id,
                        password_hash, is_active, must_change_password)
     VALUES ($1,$2,$3,$4,$5,$6,'!',FALSE,TRUE)
     RETURNING id`, [employeeId, name, ctx.values.designation ?? '', ctx.values.email ?? '', ctx.values.mobile_no ?? '', department]);
    if (created) {
        await ctx.tx.query("INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE code = 'VIEWER' ON CONFLICT DO NOTHING", [created.id]);
    }
    ctx.outcome.inserted += 1;
    ctx.errors.push({
        sheet: ctx.sheet, row: ctx.rowNumber, column: null, businessKey: employeeId,
        severity: 'WARNING', code: 'USER_INACTIVE',
        message: `User ${employeeId} (${name}) was created as INACTIVE with Viewer role. An administrator must activate the account and set a password before it can sign in.`,
    });
}
/**
 * Transactional sheets (Purchase Indent / Purchase Order / GRN).
 *
 * These are NOT imported. SRS §8 forbids sync from silently overwriting protected
 * transactional records, and creating documents here would bypass the numbering,
 * approval and quantity controls that make them trustworthy. Instead the rows are
 * RECONCILED: divergence from the ERP is reported as a CONFLICT for an
 * administrator to resolve deliberately.
 */
async function reconcileTransactionalSheet(ctx, entity) {
    if (entity === 'requisitions') {
        // Requisition is architecturally independent of the Indent/PO/GRN chain
        // (SRS: a material REQUEST, not a purchase document) but gets the exact
        // same treatment: the sheet is compared against the ERP's own numbers,
        // never used to create or mutate a requisition. HOD Approval Status /
        // Issue Slip No / Issue Date / Issued Qty are ERP-derived (v_requisition_
        // line_balance, migration 015) and are read here for the conflict
        // message only — never written back into that derivation.
        const requisitionNo = (ctx.values.requisition_no ?? '').trim();
        const itemCode = (ctx.values.item_code ?? '').trim();
        const qty = parseNumericInput(ctx.values.requisition_qty);
        if (!requisitionNo || !itemCode) {
            ctx.outcome.skipped += 1;
            return;
        }
        const line = await txQueryOne(ctx.tx, `SELECT v.requested_qty, v.issued_qty, hb.hod_status, h.status
         FROM requisition_lines l
         JOIN requisition_headers h ON h.id = l.requisition_id
         JOIN v_requisition_line_balance v ON v.requisition_line_id = l.id
         JOIN v_requisition_header_balance hb ON hb.requisition_id = h.id
        WHERE h.requisition_no = $1 AND upper(l.item_code) = upper($2)`, [requisitionNo, itemCode]);
        if (!line) {
            ctx.outcome.conflicts += 1;
            ctx.errors.push({
                sheet: ctx.sheet, row: ctx.rowNumber, column: 'Requisition No',
                businessKey: `${requisitionNo} / ${itemCode}`, severity: 'CONFLICT', code: 'MISSING_IN_ERP',
                message: `Requisition ${requisitionNo} line for ${itemCode} exists in the sheet but not in the ERP. Requisitions are not created by sync — raise it through the Requisition screen if it is genuine.`,
                incoming: { requisitionNo, itemCode, requisitionQty: qty },
            });
            return;
        }
        if (qty !== null && Number(line.requested_qty) !== Number(qty)) {
            ctx.outcome.conflicts += 1;
            ctx.errors.push({
                sheet: ctx.sheet, row: ctx.rowNumber, column: 'Requisition Qty',
                businessKey: `${requisitionNo} / ${itemCode}`, severity: 'CONFLICT', code: 'QTY_MISMATCH',
                message: `Requisition ${requisitionNo} line ${itemCode}: the sheet says ${qty} but the ERP holds ${line.requested_qty} ` +
                    `(HOD status ${line.hod_status}, document is ${line.status}). The ERP value has been kept — requested quantity is never overwritten by a spreadsheet.`,
                existing: { requestedQty: line.requested_qty, issuedQty: line.issued_qty, hodStatus: line.hod_status, status: line.status },
                incoming: { requisitionQty: qty },
            });
            return;
        }
        ctx.outcome.skipped += 1;
        return;
    }
    if (entity === 'purchase_indents') {
        const indentNo = (ctx.values.indent_no ?? '').trim();
        const itemCode = (ctx.values.item_code ?? '').trim();
        const qty = parseNumericInput(ctx.values.indent_qty);
        if (!indentNo || !itemCode) {
            ctx.outcome.skipped += 1;
            return;
        }
        const line = await txQueryOne(ctx.tx, `SELECT l.indent_qty, h.status
         FROM purchase_indent_lines l
         JOIN purchase_indent_headers h ON h.id = l.indent_id
        WHERE h.indent_no = $1 AND upper(l.item_code) = upper($2)`, [indentNo, itemCode]);
        if (!line) {
            ctx.outcome.conflicts += 1;
            ctx.errors.push({
                sheet: ctx.sheet, row: ctx.rowNumber, column: 'Indent No',
                businessKey: `${indentNo} / ${itemCode}`, severity: 'CONFLICT', code: 'MISSING_IN_ERP',
                message: `Indent ${indentNo} line for ${itemCode} exists in the sheet but not in the ERP. Transactional documents are not created by sync — raise it through the Purchase Indent screen if it is genuine.`,
                incoming: { indentNo, itemCode, indentQty: qty },
            });
            return;
        }
        if (qty !== null && Number(line.indent_qty) !== Number(qty)) {
            ctx.outcome.conflicts += 1;
            ctx.errors.push({
                sheet: ctx.sheet, row: ctx.rowNumber, column: 'Indent Qty',
                businessKey: `${indentNo} / ${itemCode}`, severity: 'CONFLICT', code: 'QTY_MISMATCH',
                message: `Indent ${indentNo} line ${itemCode}: the sheet says ${qty} but the ERP holds ${line.indent_qty} (document is ${line.status}). The ERP value has been kept.`,
                existing: { indentQty: line.indent_qty, status: line.status },
                incoming: { indentQty: qty },
            });
            return;
        }
        ctx.outcome.skipped += 1;
        return;
    }
    if (entity === 'purchase_orders') {
        const poNo = (ctx.values.po_no ?? '').trim();
        const itemCode = (ctx.values.item_code ?? '').trim();
        const qty = parseNumericInput(ctx.values.po_qty);
        const rate = parseNumericInput(ctx.values.rate);
        if (!poNo || !itemCode) {
            ctx.outcome.skipped += 1;
            return;
        }
        const line = await txQueryOne(ctx.tx, `SELECT l.po_qty, l.rate, h.status
         FROM purchase_order_lines l
         JOIN purchase_order_headers h ON h.id = l.po_id
        WHERE h.po_no = $1 AND upper(l.item_code) = upper($2)`, [poNo, itemCode]);
        if (!line) {
            ctx.outcome.conflicts += 1;
            ctx.errors.push({
                sheet: ctx.sheet, row: ctx.rowNumber, column: 'Po no',
                businessKey: `${poNo} / ${itemCode}`, severity: 'CONFLICT', code: 'MISSING_IN_ERP',
                message: `PO ${poNo} line for ${itemCode} exists in the sheet but not in the ERP. Purchase orders are not created by sync — raise it through the Purchase Order screen if it is genuine.`,
                incoming: { poNo, itemCode, poQty: qty, rate },
            });
            return;
        }
        const qtyDiffers = qty !== null && Number(line.po_qty) !== Number(qty);
        const rateDiffers = rate !== null && Number(line.rate) !== Number(rate);
        if (qtyDiffers || rateDiffers) {
            ctx.outcome.conflicts += 1;
            ctx.errors.push({
                sheet: ctx.sheet, row: ctx.rowNumber, column: qtyDiffers ? 'Po qty' : 'Rate/pc',
                businessKey: `${poNo} / ${itemCode}`, severity: 'CONFLICT', code: 'VALUE_MISMATCH',
                message: `PO ${poNo} line ${itemCode} differs from the sheet (document is ${line.status}). The ERP value has been kept — purchase orders are commercial commitments and are never overwritten by a spreadsheet.`,
                existing: { poQty: line.po_qty, rate: line.rate, status: line.status },
                incoming: { poQty: qty, rate },
            });
            return;
        }
        ctx.outcome.skipped += 1;
        return;
    }
    // GRN
    const poNo = (ctx.values.po_no ?? '').trim();
    const itemCode = (ctx.values.item_code ?? '').trim();
    const qty = parseNumericInput(ctx.values.grn_qty);
    if (!poNo || !itemCode) {
        ctx.outcome.skipped += 1;
        return;
    }
    // Joined through each LINE's own po_line_id, not the GRN header's po_id —
    // a GRN spanning several purchase orders (GRN reconstruction) leaves the
    // header po_id NULL/ambiguous, so matching per-line is what stays correct
    // for a specific PO + item combination.
    const received = await txQueryOne(ctx.tx, `SELECT COALESCE(SUM(gl.grn_qty), 0) AS received_qty
       FROM grn_lines gl
       JOIN grn_headers g ON g.id = gl.grn_id AND g.status = 'POSTED'
       JOIN purchase_order_lines pol ON pol.id = gl.po_line_id
       JOIN purchase_order_headers h ON h.id = pol.po_id
      WHERE h.po_no = $1 AND upper(gl.item_code) = upper($2)`, [poNo, itemCode]);
    const erpQty = Number(received?.received_qty ?? 0);
    if (qty !== null && erpQty === 0 && Number(qty) > 0) {
        ctx.outcome.conflicts += 1;
        ctx.errors.push({
            sheet: ctx.sheet, row: ctx.rowNumber, column: 'Grn qty',
            businessKey: `${poNo} / ${itemCode}`, severity: 'CONFLICT', code: 'MISSING_IN_ERP',
            message: `The sheet records a receipt of ${qty} for PO ${poNo} / ${itemCode} but the ERP has none. Goods receipts are not created by sync — post it through the GRN screen if it is genuine.`,
            incoming: { poNo, itemCode, grnQty: qty },
        });
        return;
    }
    ctx.outcome.skipped += 1;
}
/* ── Orchestration ──────────────────────────────────────────────────────────── */
let running = false;
export function isSyncRunning() {
    return running;
}
export async function runSync(options) {
    if (running) {
        throw IntegrationError('A synchronisation is already in progress. Please wait for it to finish.');
    }
    const cfg = syncConfig();
    if (!cfg.configured) {
        throw IntegrationError(cfg.reason ?? 'Google Sheets is not configured.');
    }
    running = true;
    const started = Date.now();
    const actor = options.actor ?? SYSTEM_ACTOR;
    const jobRow = await queryOne(`INSERT INTO google_sync_jobs (status, trigger_source, sheet_id, actor_user_id)
     VALUES ('RUNNING', $1, $2, $3) RETURNING id`, [options.trigger, cfg.sheetId, actor.userId ?? null]);
    const jobId = Number(jobRow?.id ?? 0);
    const mappings = (await query('SELECT * FROM google_sheet_mappings WHERE is_enabled = TRUE ORDER BY sync_order, sheet_name')).filter((m) => !options.sheets || options.sheets.includes(m.sheet_name));
    const outcomes = [];
    const allErrors = [];
    let failed = 0;
    for (const mapping of mappings) {
        const outcome = {
            sheet: mapping.sheet_name, entity: mapping.target_entity,
            rowsRead: 0, inserted: 0, updated: 0, skipped: 0, rejected: 0, conflicts: 0,
        };
        try {
            const grid = await readSheet(mapping.sheet_name);
            if (grid.length < 2) {
                outcome.message = 'Sheet is empty or has only a header row.';
                outcomes.push(outcome);
                continue;
            }
            const headerRow = grid[0];
            const columns = Array.isArray(mapping.column_map) ? mapping.column_map : [];
            const colIndex = resolveColumns(headerRow, columns);
            const missing = columns.filter((c) => c.required && !colIndex.has(c.field));
            if (missing.length > 0) {
                outcome.message = `Missing required column(s): ${missing.map((m) => m.headers[0]).join(', ')}.`;
                outcome.rejected = grid.length - 1;
                allErrors.push({
                    sheet: mapping.sheet_name, row: 1, column: null, businessKey: null,
                    severity: 'ERROR', code: 'MISSING_COLUMN',
                    message: `${outcome.message} Found: ${headerRow.filter(Boolean).join(', ')}.`,
                });
                outcomes.push(outcome);
                failed += 1;
                continue;
            }
            const dataRows = grid.slice(1);
            outcome.rowsRead = dataRows.length;
            if (options.dryRun) {
                outcome.skipped = dataRows.length;
                outcome.message = 'Dry run — nothing was written.';
                outcomes.push(outcome);
                continue;
            }
            // One transaction per sheet: a sheet either applies fully or not at all,
            // and a failure on sheet 5 cannot corrupt what sheets 1–4 established.
            await withTransaction(async (tx) => {
                const lookups = await loadLookupIndex(tx);
                const sheetErrors = [];
                for (const [i, row] of dataRows.entries()) {
                    const values = {};
                    for (const col of columns) {
                        const idx = colIndex.get(col.field);
                        values[col.field] = idx === undefined ? '' : (row[idx] ?? '').trim();
                    }
                    // A completely blank row is padding, not data.
                    if (Object.values(values).every((v) => v === '')) {
                        outcome.skipped += 1;
                        continue;
                    }
                    const ctx = {
                        tx, jobId, sheet: mapping.sheet_name, rowNumber: i + 2,
                        values, lookups, errors: sheetErrors, outcome,
                    };
                    try {
                        const target = mapping.target_entity;
                        if (target === 'lookups:MACHINE') {
                            await syncMachineSheet(ctx);
                        }
                        else if (target.startsWith('lookups:')) {
                            await syncLookupSheet(ctx, target.split(':')[1]);
                        }
                        else if (target === 'suppliers') {
                            await syncSupplierRow(ctx);
                        }
                        else if (target === 'items') {
                            await syncItemRow(ctx);
                        }
                        else if (target === 'users') {
                            await syncUserRow(ctx);
                        }
                        else if (target === 'purchase_indents' || target === 'purchase_orders' || target === 'grns' || target === 'requisitions') {
                            await reconcileTransactionalSheet(ctx, target);
                        }
                        else {
                            outcome.skipped += 1;
                        }
                    }
                    catch (rowErr) {
                        outcome.rejected += 1;
                        sheetErrors.push({
                            sheet: mapping.sheet_name, row: i + 2, column: null, businessKey: null,
                            severity: 'ERROR', code: 'ROW_FAILED',
                            message: rowErr instanceof Error ? rowErr.message : String(rowErr),
                        });
                    }
                }
                await recordErrors(tx, jobId, sheetErrors);
                allErrors.push(...sheetErrors);
            });
        }
        catch (sheetErr) {
            failed += 1;
            const message = sheetErr instanceof Error ? sheetErr.message : String(sheetErr);
            outcome.message = message;
            const record = {
                sheet: mapping.sheet_name, row: null, column: null, businessKey: null,
                severity: 'ERROR', code: 'SHEET_FAILED', message,
            };
            allErrors.push(record);
            await withTransaction((tx) => recordErrors(tx, jobId, [record])).catch(() => undefined);
            logger.error(`Sync failed for sheet "${mapping.sheet_name}"`, { error: message });
        }
        outcomes.push(outcome);
    }
    const totals = outcomes.reduce((acc, o) => ({
        read: acc.read + o.rowsRead,
        inserted: acc.inserted + o.inserted,
        updated: acc.updated + o.updated,
        skipped: acc.skipped + o.skipped,
        rejected: acc.rejected + o.rejected,
        conflicts: acc.conflicts + o.conflicts,
    }), { read: 0, inserted: 0, updated: 0, skipped: 0, rejected: 0, conflicts: 0 });
    const durationMs = Date.now() - started;
    const status = failed === mappings.length && mappings.length > 0 ? 'FAILED'
        : failed > 0 || totals.rejected > 0 || totals.conflicts > 0 ? 'PARTIAL'
            : 'SUCCESS';
    const message = status === 'SUCCESS'
        ? `Synchronised ${mappings.length} sheet(s): ${totals.inserted} created, ${totals.updated} updated.`
        : status === 'PARTIAL'
            ? `Completed with issues: ${totals.inserted} created, ${totals.updated} updated, ${totals.rejected} rejected, ${totals.conflicts} conflict(s) recorded for review.`
            : 'Synchronisation failed. See the sync error log for details.';
    await query(`UPDATE google_sync_jobs
        SET status = $2, finished_at = now(), duration_ms = $3, sheets_processed = $4,
            rows_read = $5, rows_inserted = $6, rows_updated = $7, rows_skipped = $8,
            rows_rejected = $9, conflicts = $10, message = $11, detail = $12::jsonb
      WHERE id = $1`, [jobId, status, durationMs, outcomes.length, totals.read, totals.inserted,
        totals.updated, totals.skipped, totals.rejected, totals.conflicts, message,
        JSON.stringify(outcomes)]);
    await audit({
        actor, action: 'SYNC', entity: 'google_sync', entityId: jobId,
        entityLabel: `Sync job #${jobId}`, source: 'GOOGLE_SYNC',
        result: status === 'SUCCESS' ? 'SUCCESS' : status === 'PARTIAL' ? 'PARTIAL' : 'FAILURE',
        after: totals, message,
    });
    running = false;
    logger.info(`Google sync ${status} in ${durationMs}ms — ${message}`);
    return { jobId, status, durationMs, sheets: outcomes, totals, message };
}
//# sourceMappingURL=engine.js.map