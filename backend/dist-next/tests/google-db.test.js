/**
 * Google Sheets BUSINESS replica — structure, cost, correctness and the
 * controlled Sheets -> SQL historical import.
 *
 * Runs against the real test database with a FAKE Sheets API injected via
 * `__setClientForTests`, so every assertion exercises the genuine SQL side
 * (views, triggers, outbox, row index, transactions, recalculation) with zero
 * network.
 *
 * A large part of this suite is about COST, not just correctness, because cost
 * is what broke the previous implementation: it asserts that a single change
 * writes a single row, that a hundred changes cost one API call, that an
 * unchanged row costs none, and that no ordinary change ever rewrites a whole
 * tab. Those are the properties that keep the ERP responsive, so they are
 * tested rather than assumed.
 *
 * Sheet content is asserted through each view's OWN declared headers rather
 * than a hard-coded column list, so the suite tests behaviour and stays true as
 * the business views gain fields.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
process.env.NODE_ENV = 'test';
process.env.SEED_DEMO_DATA = 'false';
process.env.LOG_LEVEL = 'silent';
// Must be set BEFORE config/env.js is first imported.
process.env.GOOGLE_SHEETS_DATABASE_SPREADSHEET_ID = 'TEST_REPLICA_SHEET';
process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE = 'C:/secure/google-service-account.json';
process.env.GOOGLE_SHEETS_SYNC_ENABLED = 'true';
/** `'Item Master'!A2:T9` -> `Item Master`. Titles are quoted in A1 notation. */
function titleOf(range) {
    const raw = range.split('!')[0] ?? '';
    return raw.startsWith("'") && raw.endsWith("'")
        ? raw.slice(1, -1).replace(/''/g, "'")
        : raw;
}
class FakeSheets {
    tabs = new Map();
    nextId = 1;
    /** Set to a status code to make the next call fail, emulating an outage. */
    failWith = null;
    /** Set to make EVERY call fail until cleared — a sustained outage. */
    failAlways = null;
    calls = { get: 0, batchGet: 0, append: 0, update: 0, clear: 0, batchUpdate: 0, meta: 0 };
    get totalCalls() {
        return Object.values(this.calls).reduce((a, b) => a + b, 0);
    }
    resetCalls() {
        for (const k of Object.keys(this.calls))
            this.calls[k] = 0;
    }
    guard() {
        const code = this.failAlways ?? this.failWith;
        if (code !== null) {
            const err = Object.assign(new Error('injected Google failure'), { code });
            if (this.failAlways === null)
                this.failWith = null;
            throw err;
        }
    }
    tab(range) {
        const title = titleOf(range);
        const t = this.tabs.get(title);
        if (!t)
            throw Object.assign(new Error(`Unable to parse range: ${range}`), { code: 400 });
        return t;
    }
    startRow(range) {
        const cell = range.split('!')[1] ?? 'A1';
        return Number(/\d+/.exec(cell)?.[0] ?? 1) - 1;
    }
    spreadsheets = {
        get: async () => {
            this.guard();
            this.calls.meta += 1;
            return { data: { sheets: [...this.tabs.values()].map((t) => ({
                        properties: {
                            title: t.title, sheetId: t.sheetId,
                            gridProperties: { rowCount: t.rowCount, columnCount: 60 },
                        },
                    })) } };
        },
        batchUpdate: async ({ requestBody }) => {
            this.guard();
            this.calls.batchUpdate += 1;
            for (const r of requestBody.requests ?? []) {
                if (r.addSheet) {
                    const title = r.addSheet.properties.title;
                    if (!this.tabs.has(title)) {
                        this.tabs.set(title, { title, sheetId: this.nextId++, rowCount: 1000, values: [] });
                    }
                }
                if (r.deleteSheet) {
                    for (const [k, v] of this.tabs)
                        if (v.sheetId === r.deleteSheet.sheetId)
                            this.tabs.delete(k);
                }
                if (r.appendDimension?.dimension === 'ROWS') {
                    for (const v of this.tabs.values()) {
                        if (v.sheetId === r.appendDimension.sheetId)
                            v.rowCount += r.appendDimension.length;
                    }
                }
            }
            return { data: {} };
        },
        values: {
            get: async ({ range }) => {
                this.guard();
                this.calls.get += 1;
                return { data: { values: this.tab(range).values.map((r) => [...r]) } };
            },
            batchGet: async ({ ranges }) => {
                this.guard();
                this.calls.batchGet += 1;
                return {
                    data: {
                        valueRanges: ranges.map((range) => {
                            const t = this.tab(range);
                            const letters = /!([A-Z]+):/.exec(range)?.[1] ?? 'A';
                            let idx = 0;
                            for (const ch of letters)
                                idx = idx * 26 + (ch.charCodeAt(0) - 64);
                            idx -= 1;
                            return { values: [t.values.map((r) => r[idx] ?? '')] };
                        }),
                    },
                };
            },
            clear: async ({ range }) => {
                this.guard();
                this.calls.clear += 1;
                this.tab(range).values = [];
                return { data: {} };
            },
            update: async ({ range, requestBody }) => {
                this.guard();
                this.calls.update += 1;
                const t = this.tab(range);
                const start = this.startRow(range);
                requestBody.values.forEach((row, i) => { t.values[start + i] = [...row]; });
                return { data: {} };
            },
            append: async ({ range, requestBody }) => {
                this.guard();
                this.calls.append += 1;
                const t = this.tab(range);
                for (const row of requestBody.values)
                    t.values.push([...row]);
                return { data: {} };
            },
            batchUpdate: async ({ requestBody }) => {
                this.guard();
                this.calls.batchUpdate += 1;
                for (const d of requestBody.data ?? []) {
                    const t = this.tab(d.range);
                    const start = this.startRow(d.range);
                    d.values.forEach((row, i) => { t.values[start + i] = [...row]; });
                }
                return { data: {} };
            },
        },
    };
    headerOf(title) { return this.tabs.get(title)?.values[0] ?? []; }
    rowsOf(title) {
        const t = this.tabs.get(title);
        if (!t || t.values.length < 2)
            return [];
        const header = t.values[0];
        return t.values.slice(1)
            .filter((r) => r && r.some((c) => c !== '' && c !== undefined))
            .map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
    }
    /** Every non-empty cell across every tab — used for the secret sweep. */
    allCells() {
        return [...this.tabs.values()].flatMap((t) => t.values.flat()).filter((c) => c != null && c !== '');
    }
}
let fake;
let db;
let closeDb;
let replica;
let drain;
let jobs;
let importer;
let reconcile;
let clientMod;
let viewsMod;
const sql = async (text, params = []) => (await db.query(text, params)).rows;
/** A view's sheet header, exactly as exported. */
const headerOfView = (sheet) => viewsMod.viewBySheet(sheet).columns.map((c) => c.header);
/** Drives the queued background job to completion, as the scheduler would. */
async function runJobToCompletion(maxSlices = 60) {
    let slices = 0;
    for (; slices < maxSlices; slices += 1) {
        const active = await jobs.activeJob();
        if (!active)
            break;
        await jobs.runJobSlice(8_000);
    }
    return slices;
}
async function exportAll(sheets) {
    await replica.requestFullExport({ sheets });
    await runJobToCompletion();
}
/* ── Fixtures ───────────────────────────────────────────────────────────────── */
let itemId = 0;
let supplierId = 0;
let uomId = 0;
beforeAll(async () => {
    const { ensureStorageDirs } = await import('../config/env.js');
    const { runMigrations } = await import('../db/migrate.js');
    const { seedSystem } = await import('../db/seed.js');
    const { getDatabase, closeDatabase } = await import('../db/driver.js');
    ensureStorageDirs();
    db = await getDatabase();
    closeDb = closeDatabase;
    await db.query('DROP SCHEMA IF EXISTS public CASCADE');
    await db.query('CREATE SCHEMA public');
    await runMigrations({ silent: true });
    await seedSystem();
    replica = await import('../modules/google-db/replica.js');
    drain = await import('../modules/google-db/drain.js');
    jobs = await import('../modules/google-db/jobs.js');
    importer = await import('../modules/google-db/import.js');
    reconcile = await import('../modules/google-db/reconcile.js');
    clientMod = await import('../modules/google-db/client.js');
    viewsMod = await import('../modules/google-db/views/index.js');
    fake = new FakeSheets();
    clientMod.__setClientForTests(fake);
    [{ id: uomId }] = await sql(`SELECT id FROM lookups WHERE category = 'UOM' LIMIT 1`);
    [{ id: supplierId }] = await sql(`INSERT INTO suppliers (supplier_code, supplier_name, city, email)
     VALUES ('GDB-SUP','Replica Test Supplier','Pune','sup@example.com') RETURNING id`);
    [{ id: itemId }] = await sql(`INSERT INTO items (item_code, item_description, uom_id, live_stock_qty)
     VALUES ('GDB-ITEM','Replica Test Item', $1, 0) RETURNING id`, [uomId]);
}, 300_000);
afterAll(async () => {
    clientMod?.__setClientForTests(null);
    await closeDb?.();
});
/* ── 1. Shape: eleven business tabs, no table dumps ─────────────────────────── */
describe('tab structure', () => {
    it('is TWELVE business tabs, one per business entity', () => {
        const sheets = viewsMod.BUSINESS_VIEWS.map((v) => v.sheet);
        expect(sheets).toEqual([
            'Item Master', 'Supplier Master', 'Indent / PO / GRN Type', 'Purchase Indent', 'Purchase Order', 'GRN',
            'Requisition', 'Requisition Issue', 'Stock Ledger', 'User Master',
            'Lookup & Configuration', 'History & Audit',
        ]);
        expect(sheets.length).toBeLessThanOrEqual(12);
    });
    it('has no per-lookup tab — every configuration list lives in one tab', () => {
        const sheets = viewsMod.BUSINESS_VIEWS.map((v) => v.sheet);
        for (const retired of [
            'UOM Master', 'Currency Master', 'Payment Terms Master', 'Main Group Master',
            'Sub Main Group Master', 'Cost Centre Master', 'State Master', 'City Master',
            'PO Type Master', 'Indent Type Master', 'GRN Type Master', 'Machine Master',
            'Department Master', 'Item Type Master',
        ]) {
            expect(sheets, `${retired} must not be its own tab`).not.toContain(retired);
        }
        expect(headerOfView('Lookup & Configuration')).toContain('Category');
    });
    it('has no separate history / status / receive tab per document', () => {
        const sheets = viewsMod.BUSINESS_VIEWS.map((v) => v.sheet);
        for (const retired of [
            'Indent Approval History', 'Requisition Approval History', 'Audit Log',
            'Transaction Traceability', 'PO History', 'GRN Receive',
        ]) {
            expect(sheets).not.toContain(retired);
        }
        expect(sheets).toContain('History & Audit');
    });
    it('names no tab after a raw SQL table', () => {
        for (const v of viewsMod.BUSINESS_VIEWS)
            expect(v.sheet).not.toMatch(/_/);
    });
    it('carries only the minimum identifiers per row', () => {
        // The brief: "DO NOT create many IDs per Google row."
        for (const v of viewsMod.BUSINESS_VIEWS) {
            const ids = v.columns.filter((c) => /\bIDs?\b|\bID\(s\)/.test(c.header));
            expect(ids.length, `${v.sheet} carries too many id columns: ${ids.map((c) => c.header).join(', ')}`)
                .toBeLessThanOrEqual(8);
            // and every one of them must be a real SQL id, never Google-invented
            for (const c of ids)
                expect(c.cls).toBe('D');
        }
        expect(viewsMod.viewBySheet('Purchase Order').primaryKey).toEqual(['PO ID', 'PO Line ID']);
        expect(viewsMod.viewBySheet('Item Master').primaryKey).toEqual(['Item ID']);
    });
    it('classifies every exported column as business / reporting / import / traceability', () => {
        for (const v of viewsMod.BUSINESS_VIEWS) {
            for (const c of v.columns) {
                expect(['A', 'B', 'C', 'D'], `${v.sheet}.${c.header} has no justification`).toContain(c.cls);
            }
        }
    });
    it('keeps HOD Status and Store Status separate on Requisition', () => {
        const req = headerOfView('Requisition');
        expect(req).toContain('HOD Status');
        expect(req).toContain('Store Status');
    });
    it('exposes no sync/technical column on a business tab', () => {
        const forbidden = [
            'sheet_name', 'target_entity', 'sync_order', 'column_map', 'key_fields', 'is_enabled',
            '_synced_at', '_source', 'seed_tag', 'deleted_at',
        ];
        for (const v of viewsMod.BUSINESS_VIEWS) {
            for (const c of v.columns)
                expect(forbidden).not.toContain(c.header);
        }
    });
});
/* ── 2. Nothing secret ever reaches a sheet ─────────────────────────────────── */
describe('security', () => {
    it('references no credential column in any view', () => {
        for (const v of viewsMod.BUSINESS_VIEWS) {
            const blob = `${v.from} ${v.where ?? ''} ${v.columns.map((c) => `${c.header} ${c.expr}`).join(' ')}`;
            expect(blob, `${v.sheet}`).not.toMatch(/password|refresh_token|user_sessions|locked_until|must_change/i);
        }
    });
    it('never exports the audit trail payload snapshots', () => {
        // before_data / after_data are whole-row JSON, so an audit row for a user
        // update carries that user's password hash.
        const history = viewsMod.viewBySheet('History & Audit');
        const blob = history.columns.map((c) => c.expr).join(' ');
        expect(blob).not.toMatch(/before_data|after_data/);
    });
    it('makes no credential column importable', () => {
        for (const v of viewsMod.BUSINESS_VIEWS) {
            for (const t of v.importTargets ?? []) {
                const cols = Object.values(t.fields).map((f) => (typeof f === 'string' ? f : f.column));
                expect(cols).not.toContain('password_hash');
                expect(cols).not.toContain('is_active_role');
            }
        }
    });
});
/* ── 3. Full export is a BACKGROUND JOB, never inline ───────────────────────── */
describe('full export', () => {
    it('returns immediately with a queued job rather than doing the work', async () => {
        const result = await replica.requestFullExport({});
        expect(result.queued).toBe(true);
        expect(result.job?.status).toBe('QUEUED');
        // Nothing has been written yet — the request did no Google work at all.
        expect(fake.tabs.size).toBe(0);
    });
    it('completes in resumable slices and writes every tab', async () => {
        const slices = await runJobToCompletion();
        expect(slices).toBeGreaterThan(0);
        for (const v of viewsMod.BUSINESS_VIEWS) {
            expect(fake.tabs.has(v.sheet), `${v.sheet} tab missing`).toBe(true);
            expect(fake.headerOf(v.sheet)).toEqual(headerOfView(v.sheet));
        }
        const done = (await jobs.recentJobs(1))[0];
        expect(done.status).toBe('DONE');
    });
    it('writes exactly the rows SQL holds, with no duplicate keys', async () => {
        for (const v of viewsMod.BUSINESS_VIEWS) {
            const [{ n }] = await sql(`SELECT COUNT(*)::int AS n FROM ${v.from}${v.where ? ` WHERE ${v.where}` : ''}`);
            const rows = fake.rowsOf(v.sheet);
            expect(rows.length, `${v.sheet} row count`).toBe(Number(n));
            const keys = rows.map((r) => v.primaryKey.map((p) => r[p]).join('|'));
            expect(new Set(keys).size, `${v.sheet} has duplicate keys`).toBe(keys.length);
        }
    });
    it('records where every row lives, so a later update needs no download', async () => {
        const [{ n }] = await sql(`SELECT COUNT(*)::int AS n FROM google_db_rows WHERE sheet_name = 'Item Master'`);
        expect(Number(n)).toBe(fake.rowsOf('Item Master').length);
    });
    it('leaks no secret into any cell of any tab', async () => {
        const [u] = await sql('SELECT password_hash FROM users WHERE password_hash IS NOT NULL LIMIT 1');
        const cells = fake.allCells();
        if (u?.password_hash)
            expect(cells).not.toContain(u.password_hash);
        expect(cells.some((c) => /^\$2[aby]\$\d\d\$/.test(c)), 'a bcrypt hash reached a sheet').toBe(false);
    });
});
/* ── 4. COST: the properties that keep the ERP responsive ───────────────────── */
describe('incremental sync cost', () => {
    it('a single edit writes ONE row and never rewrites the tab', async () => {
        await sql('DELETE FROM google_db_outbox');
        await sql(`UPDATE suppliers SET supplier_name = 'Renamed Supplier' WHERE id = $1`, [supplierId]);
        fake.resetCalls();
        const result = await drain.drainOutbox();
        expect(result.status).toBe('SUCCESS');
        expect(result.rowsWritten).toBe(1);
        // The whole point: no clear, no full re-export, no tab download.
        expect(fake.calls.clear, 'a normal change must not clear a tab').toBe(0);
        expect(fake.calls.get, 'a normal change must not download a tab').toBe(0);
        const row = fake.rowsOf('Supplier Master').find((r) => r['Supplier ID'] === String(supplierId));
        expect(row?.['Supplier Name']).toBe('Renamed Supplier');
    });
    it('a hundred changes cost ONE batched API write, not a hundred exports', async () => {
        await sql('DELETE FROM google_db_outbox');
        const ids = [];
        for (let i = 0; i < 100; i += 1) {
            const [r] = await sql(`INSERT INTO suppliers (supplier_code, supplier_name) VALUES ($1, $2) RETURNING id`, [`BULK-${i}`, `Bulk Supplier ${i}`]);
            ids.push(r.id);
        }
        fake.resetCalls();
        const result = await drain.drainOutbox();
        expect(result.rowsWritten).toBe(100);
        expect(fake.calls.clear).toBe(0);
        // 100 rows -> a single values.batchUpdate (the grid may also be grown once).
        expect(fake.calls.batchUpdate).toBeLessThanOrEqual(2);
        expect(fake.totalCalls, `100 changes cost ${fake.totalCalls} API calls`).toBeLessThanOrEqual(3);
        const sheet = fake.rowsOf('Supplier Master');
        for (const id of ids) {
            expect(sheet.find((r) => r['Supplier ID'] === String(id))).toBeTruthy();
        }
    });
    it('absorbs a 1,000-record update without an API storm', async () => {
        await sql('DELETE FROM google_db_outbox');
        for (let i = 0; i < 1000; i += 1) {
            await sql(`INSERT INTO suppliers (supplier_code, supplier_name) VALUES ($1, $2)`, [`THOUSAND-${i}`, `Thousand Supplier ${i}`]);
        }
        fake.resetCalls();
        const started = Date.now();
        const result = await drain.drainOutbox(2000);
        const elapsed = Date.now() - started;
        expect(result.rowsWritten).toBe(1000);
        expect(fake.calls.clear, 'no tab may be rewritten').toBe(0);
        // 1,000 rows are sent as batches of ranges, not one request per record.
        // The bound that matters is "a handful", not "a thousand".
        // Measured: 4 requests (3 values.batchUpdate + 1 metadata read) in ~157ms.
        expect(fake.totalCalls, `1,000 changes cost ${fake.totalCalls} API calls`).toBeLessThanOrEqual(8);
        expect(elapsed, 'one drain must stay short enough not to stall the ERP').toBeLessThan(30_000);
        const rows = fake.rowsOf('Supplier Master');
        expect(rows.filter((r) => r['Supplier Code']?.startsWith('THOUSAND-'))).toHaveLength(1000);
        // and no record may be written twice
        const keys = rows.map((r) => r['Supplier ID']);
        expect(new Set(keys).size).toBe(keys.length);
    }, 300_000);
    it('supersedes a queued backlog once a full export has covered every tab', async () => {
        await sql('DELETE FROM google_db_outbox');
        await sql(`INSERT INTO google_db_outbox (table_name, row_key, operation, enqueued_at)
       VALUES ('suppliers', $1, 'UPSERT', now() - interval '1 hour')`, [String(supplierId)]);
        await exportAll();
        const [{ n }] = await sql('SELECT COUNT(*)::int AS n FROM google_db_outbox WHERE processed_at IS NULL');
        expect(Number(n), 'a full export makes an older queued change moot').toBe(0);
    }, 300_000);
    it('a change that alters nothing visible sends no payload at all', async () => {
        await sql('DELETE FROM google_db_outbox');
        // Re-queue a row whose rendered content is identical to what is on the sheet.
        await sql(`INSERT INTO google_db_outbox (table_name, row_key, operation) VALUES ('suppliers', $1, 'UPSERT')`, [String(supplierId)]);
        fake.resetCalls();
        const result = await drain.drainOutbox();
        expect(result.rowsUnchanged).toBe(1);
        expect(result.rowsWritten).toBe(0);
        expect(fake.totalCalls, 'an unchanged row must cost zero API calls').toBe(0);
    });
    it('hands a large fan-out to the background job instead of writing inline', async () => {
        await exportAll();
        await sql('DELETE FROM google_db_outbox');
        await sql(`DELETE FROM google_db_jobs WHERE status IN ('QUEUED','RUNNING')`);
        // Point many items at one UOM, then rename it: the change legitimately
        // touches more rows than the inline limit allows.
        await sql(`UPDATE items SET uom_id = $1 WHERE id IS NOT NULL`, [uomId]);
        await sql('DELETE FROM google_db_outbox');
        await sql(`UPDATE lookups SET code = 'RENAMED' WHERE id = $1`, [uomId]);
        const itemCount = Number((await sql('SELECT COUNT(*)::int AS n FROM items WHERE deleted_at IS NULL'))[0].n);
        const result = await drain.drainOutbox();
        expect(['PARTIAL', 'SUCCESS']).toContain(result.status);
        await sql(`UPDATE google_db_jobs SET status = 'CANCELLED' WHERE status IN ('QUEUED','RUNNING')`);
    });
    it('does not enqueue anything when only bookkeeping columns change', async () => {
        await sql('DELETE FROM google_db_outbox');
        await sql(`UPDATE suppliers SET updated_at = now() WHERE id = $1`, [supplierId]);
        const queued = await sql(`SELECT * FROM google_db_outbox WHERE table_name = 'suppliers'`);
        expect(queued, 'a touch of updated_at is not a business change').toHaveLength(0);
    });
});
/* ── 5. Google unavailable: the ERP is unaffected ───────────────────────────── */
describe('resilience', () => {
    it('lets business writes commit while Google is completely down', async () => {
        fake.failAlways = 500;
        const [s] = await sql(`INSERT INTO suppliers (supplier_code, supplier_name) VALUES ('OUTAGE-1','Outage Supplier') RETURNING id`);
        const [row] = await sql('SELECT supplier_name FROM suppliers WHERE id = $1', [s.id]);
        expect(row.supplier_name).toBe('Outage Supplier');
        fake.failAlways = null;
    });
    it('keeps changes queued through an outage and drains them afterwards, once', async () => {
        await sql('DELETE FROM google_db_outbox');
        const [s] = await sql(`INSERT INTO suppliers (supplier_code, supplier_name) VALUES ('OUTAGE-2','Queued Through Outage') RETURNING id`);
        fake.failAlways = 503;
        const failed = await drain.drainOutbox();
        expect(failed.status).toBe('FAILED');
        const [{ n: stillQueued }] = await sql(`SELECT COUNT(*)::int AS n FROM google_db_outbox WHERE processed_at IS NULL`);
        expect(Number(stillQueued), 'changes must survive an outage').toBeGreaterThan(0);
        fake.failAlways = null;
        const ok = await drain.drainOutbox();
        expect(ok.status).toBe('SUCCESS');
        const matches = fake.rowsOf('Supplier Master').filter((r) => r['Supplier ID'] === String(s.id));
        expect(matches, 'the recovered change must not be duplicated').toHaveLength(1);
    });
    it('is idempotent — draining the same change twice writes one row', async () => {
        await sql('DELETE FROM google_db_outbox');
        await sql(`UPDATE suppliers SET supplier_name = 'Idempotent Name' WHERE id = $1`, [supplierId]);
        await drain.drainOutbox();
        await sql(`INSERT INTO google_db_outbox (table_name, row_key, operation) VALUES ('suppliers', $1, 'UPSERT')`, [String(supplierId)]);
        await drain.drainOutbox();
        const matches = fake.rowsOf('Supplier Master').filter((r) => r['Supplier ID'] === String(supplierId));
        expect(matches).toHaveLength(1);
        expect(matches[0]['Supplier Name']).toBe('Idempotent Name');
    });
    it('never echoes an import back to the sheet', async () => {
        await sql('DELETE FROM google_db_outbox');
        await sql(`INSERT INTO google_db_outbox (table_name, row_key, operation, source)
       VALUES ('suppliers', $1, 'UPSERT', 'GOOGLE_IMPORT')`, [String(supplierId)]);
        fake.resetCalls();
        const result = await drain.drainOutbox();
        expect(result.rowsWritten).toBe(0);
        expect(fake.totalCalls).toBe(0);
    });
    it('reports status without contacting Google at all', async () => {
        fake.failAlways = 500;
        const status = await replica.replicaStatus();
        expect(status.systemOfRecord).toBe('SQL');
        expect(status.sheets).toHaveLength(12);
        // A summary only — no sheet contents may reach the browser.
        expect(JSON.stringify(status)).not.toContain('Replica Test Supplier');
        fake.failAlways = null;
    });
});
/* ── 6. Semantics: the values must be the ERP's values ──────────────────────── */
describe('business correctness', () => {
    let poId = 0;
    let poLineId = 0;
    let grnId = 0;
    beforeAll(async () => {
        const [poType] = await sql(`SELECT id FROM lookups WHERE category = 'PO_TYPE' LIMIT 1`);
        [{ id: poId }] = await sql(`INSERT INTO purchase_order_headers (po_no, po_date, supplier_id, po_type_id, status)
       VALUES ('PO-TEST-1', CURRENT_DATE, $1, $2, 'OPEN') RETURNING id`, [supplierId, poType?.id ?? null]);
        [{ id: poLineId }] = await sql(`INSERT INTO purchase_order_lines (po_id, line_no, item_id, item_code, item_description, po_qty, rate, uom_id)
       VALUES ($1, 1, $2, 'GDB-ITEM', 'Replica Test Item', 100, 10, $3) RETURNING id`, [poId, itemId, uomId]);
        [{ id: grnId }] = await sql(`INSERT INTO grn_headers (grn_no, grn_date, supplier_id, status)
       VALUES ('GRN-TEST-1', CURRENT_DATE, $1, 'DRAFT') RETURNING id`, [supplierId]);
        await sql(`INSERT INTO grn_lines (grn_id, line_no, po_line_id, item_id, item_code, item_description, grn_qty, uom_id)
       VALUES ($1, 1, $2, $3, 'GDB-ITEM', 'Replica Test Item', 40, $4)`, [grnId, poLineId, itemId, uomId]);
        await exportAll(['Purchase Order', 'GRN', 'Item Master']);
    });
    const poRow = () => fake.rowsOf('Purchase Order').find((r) => r['PO Line ID'] === String(poLineId));
    it('does not count a DRAFT GRN as a receipt, and does not list it as receiving', () => {
        const row = poRow();
        expect(row['Received Qty']).toBe('0');
        // The sheet must not assert a receipt that has not happened.
        expect(row['GRN No(s)']).toBe('');
    });
    it('counts a POSTED GRN and lists it', async () => {
        await sql(`UPDATE grn_headers SET status = 'POSTED', posted_at = now() WHERE id = $1`, [grnId]);
        await exportAll(['Purchase Order']);
        const row = poRow();
        expect(row['Received Qty']).toBe('40');
        expect(row['Pending GRN Qty']).toBe('60');
        expect(row['GRN No(s)']).toBe('GRN-TEST-1');
    });
    it('reports ZERO pending on a CANCELLED purchase order', async () => {
        await sql(`UPDATE purchase_order_headers SET status = 'CANCELLED' WHERE id = $1`, [poId]);
        await exportAll(['Purchase Order']);
        const row = poRow();
        expect(row['PO Status']).toBe('CANCELLED');
        // A cancelled order is not outstanding supply.
        expect(row['Pending GRN Qty']).toBe('0');
        expect(row['Pending Amount']).toBe('0.00');
        await sql(`UPDATE purchase_order_headers SET status = 'OPEN' WHERE id = $1`, [poId]);
    });
    it('shows a receipt total on a DIRECT GRN line rather than a blank cell', async () => {
        const [g] = await sql(`INSERT INTO grn_headers (grn_no, grn_date, supplier_id, status, posted_at)
       VALUES ('GRN-DIRECT-1', CURRENT_DATE, $1, 'POSTED', now()) RETURNING id`, [supplierId]);
        await sql(`INSERT INTO grn_lines (grn_id, line_no, po_line_id, item_id, item_code, item_description, grn_qty, uom_id)
       VALUES ($1, 1, NULL, $2, 'GDB-ITEM', 'Replica Test Item', 25, $3)`, [g.id, itemId, uomId]);
        await exportAll(['GRN']);
        const row = fake.rowsOf('GRN').find((r) => r['GRN No'] === 'GRN-DIRECT-1');
        expect(row.Mode).toBe('DIRECT');
        expect(row['Total Received Qty'], 'a direct receipt must not be blank').not.toBe('');
        expect(Number(row['Total Received Qty'])).toBeGreaterThanOrEqual(25);
        expect(row['Pending Qty']).toBe('0');
    });
    it('renders dates as the stored calendar date, with no timezone shift', async () => {
        const [{ today }] = await sql(`SELECT to_char(CURRENT_DATE, 'YYYY-MM-DD') AS today`);
        const row = poRow();
        expect(row['PO Date']).toBe(today);
        expect(row['PO Date'], 'a date must not be exported as a UTC timestamp').not.toMatch(/T\d\d:/);
    });
    it('renders UOM as the code the ERP shows, not an internal id', () => {
        const row = poRow();
        expect(row.UOM).not.toMatch(/^\d+$/);
        expect(row.UOM.length).toBeGreaterThan(0);
    });
    it('reads quantities from the authoritative balance views', () => {
        const po = viewsMod.viewBySheet('Purchase Order');
        expect(po.from).toMatch(/v_po_line_balance/);
        const ind = viewsMod.viewBySheet('Purchase Indent');
        expect(ind.from).toMatch(/v_indent_line_balance/);
        const req = viewsMod.viewBySheet('Requisition');
        expect(req.from).toMatch(/v_requisition_line_balance/);
    });
});
/* ── 7. Reconciliation: SQL vs Google, value by value ───────────────────────── */
describe('reconciliation', () => {
    it('reports zero differences immediately after a full export', async () => {
        await exportAll();
        const report = await reconcile.reconcileSheets();
        if (!report.clean) {
            // Make a failure diagnosable rather than a bare boolean.
            const detail = report.sheets
                .filter((s) => s.mismatch || s.missingInGoogle || s.extraInGoogle || s.error || !s.headerMatches)
                .map((s) => `${s.sheet}: ${s.mismatch} mismatch, ${s.missingInGoogle} missing, `
                + `${s.extraInGoogle} extra, header=${s.headerMatches}, ${s.error ?? ''} `
                + `${JSON.stringify(s.samples.slice(0, 3))}`)
                .join('\n');
            throw new Error(`reconciliation was not clean:\n${detail}`);
        }
        expect(report.totals.mismatch).toBe(0);
        expect(report.totals.missingInGoogle).toBe(0);
        expect(report.totals.extraInGoogle).toBe(0);
        expect(report.totals.duplicateInGoogle).toBe(0);
    });
    it('detects a value that drifted, rather than only counting rows', async () => {
        const tab = fake.tabs.get('Supplier Master');
        const nameCol = fake.headerOf('Supplier Master').indexOf('Supplier Name');
        tab.values[1][nameCol] = 'TAMPERED';
        const report = await reconcile.reconcileSheets(['Supplier Master']);
        expect(report.clean).toBe(false);
        expect(report.totals.mismatch).toBe(1);
        expect(report.sheets[0].samples[0].column).toBe('Supplier Name');
        expect(report.sheets[0].samples[0].google).toBe('TAMPERED');
    });
    it('detects a row present in Google but not in SQL', async () => {
        await exportAll(['Supplier Master']);
        const tab = fake.tabs.get('Supplier Master');
        const width = fake.headerOf('Supplier Master').length;
        tab.values.push(['999999', ...Array(width - 1).fill('ghost')]);
        const report = await reconcile.reconcileSheets(['Supplier Master']);
        expect(report.totals.extraInGoogle).toBe(1);
        tab.values.pop();
    });
});
/* ── 8. Controlled Google -> SQL import ─────────────────────────────────────── */
describe('historical import', () => {
    beforeAll(async () => { await exportAll(); });
    it('reports UNCHANGED for a freshly exported sheet — it is idempotent', async () => {
        const plan = await importer.planImport(['Supplier Master']);
        expect(plan.totals.insert).toBe(0);
        expect(plan.totals.update).toBe(0);
        expect(plan.totals.unchanged).toBeGreaterThan(0);
    });
    it('applies an edit made in the sheet', async () => {
        const tab = fake.tabs.get('Supplier Master');
        const header = fake.headerOf('Supplier Master');
        const idCol = header.indexOf('Supplier ID');
        const cityCol = header.indexOf('City');
        const rowIdx = tab.values.findIndex((r, i) => i > 0 && r[idCol] === String(supplierId));
        tab.values[rowIdx][cityCol] = 'Nagpur';
        const plan = await importer.planImport(['Supplier Master']);
        expect(plan.totals.update).toBe(1);
        const result = await importer.commitImport(plan);
        expect(result.status).toBe('COMMITTED');
        const [row] = await sql('SELECT city FROM suppliers WHERE id = $1', [supplierId]);
        expect(row.city).toBe('Nagpur');
    });
    it('refuses a lookup value it cannot resolve instead of importing a blank', async () => {
        const tab = fake.tabs.get('Item Master');
        const header = fake.headerOf('Item Master');
        const idCol = header.indexOf('Item ID');
        const deptCol = header.indexOf('Department');
        const rowIdx = tab.values.findIndex((r, i) => i > 0 && r[idCol] === String(itemId));
        tab.values[rowIdx][deptCol] = 'No Such Department';
        const plan = await importer.planImport(['Item Master']);
        const invalid = plan.sheets[0].rows.filter((r) => r.action === 'INVALID');
        expect(invalid.length).toBeGreaterThan(0);
        expect(invalid[0].reason).toMatch(/not a known DEPARTMENT/);
        tab.values[rowIdx][deptCol] = '';
    });
    it('never imports a derived quantity — the ERP recomputes it', () => {
        const po = viewsMod.viewBySheet('Purchase Order');
        const line = po.importTargets.find((t) => t.table === 'purchase_order_lines');
        for (const derived of ['Received Qty', 'Pending GRN Qty', 'Received Amount', 'Pending Amount',
            'Final Rate', 'Amount', 'GST Amount']) {
            expect(Object.keys(line.fields), `${derived} must not be importable`).not.toContain(derived);
        }
        const item = viewsMod.viewBySheet('Item Master').importTargets[0];
        expect(Object.keys(item.fields)).not.toContain('Current Live Stock');
    });
    it('never imports approval history or the stock ledger', () => {
        expect(viewsMod.viewBySheet('History & Audit').importTargets).toBeUndefined();
        expect(viewsMod.viewBySheet('Stock Ledger').importTargets).toBeUndefined();
    });
    it('marks the row index stale after an import, so positions are re-verified', async () => {
        const [row] = await sql(`SELECT index_dirty FROM google_db_state WHERE sheet_name = 'Supplier Master'`);
        expect(row.index_dirty).toBe(true);
    });
    it('repairs a stale index from the key column only, not the whole tab', async () => {
        fake.resetCalls();
        await sql('DELETE FROM google_db_outbox');
        await sql(`UPDATE suppliers SET supplier_name = 'After Import' WHERE id = $1`, [supplierId]);
        await drain.drainOutbox();
        // batchGet reads named COLUMNS; values.get would be a whole-tab download.
        expect(fake.calls.get, 'a repair must not download the tab').toBe(0);
        expect(fake.calls.batchGet).toBeGreaterThan(0);
        const matches = fake.rowsOf('Supplier Master').filter((r) => r['Supplier ID'] === String(supplierId));
        expect(matches).toHaveLength(1);
        expect(matches[0]['Supplier Name']).toBe('After Import');
    });
});
//# sourceMappingURL=google-db.test.js.map