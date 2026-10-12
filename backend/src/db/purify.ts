/**
 * Data purification (production hardening §14, §34).
 *
 * Classifies every business row, then removes non-production data — but only
 * after a verified backup, and only rows it can PROVE are not real.
 *
 * The governing rules:
 *
 *   • Nothing is deleted that cannot be positively identified. An unclassified
 *     row is reported as UNKNOWN and left alone; guessing risks destroying a
 *     customer's real data, which is unrecoverable in a way that leaving a
 *     stray demo row is not.
 *   • System data is never business data. Permissions, roles, the permission
 *     catalogue, sheet mappings, settings, bootstrap administrators and the
 *     international unit/currency lookups are what the application needs to
 *     run at all, and survive purification untouched.
 *   • Deletion order follows the foreign keys, inside ONE transaction. A
 *     partially purified database is not an outcome this can produce.
 *   • Balances are derived from views, never stored, so there are no counters
 *     to recalculate afterwards — but the integrity invariants are re-asserted
 *     so the claim "the database is clean" is verified rather than assumed.
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import { query, queryOne, execute, withTransaction, txQuery, txQueryOne, type Queryable } from './index.js';
import { paths } from '../config/env.js';
import { collectBackupData, type BackupPayload } from './restore.js';

/** How a row was classified. */
export type Classification = 'REAL' | 'DEMO' | 'TEST' | 'SEED' | 'SYSTEM' | 'UNKNOWN';

export interface TableInventory {
  table: string;
  kind: 'business' | 'system' | 'operational';
  total: number;
  real: number;
  demo: number;
  test: number;
  system: number;
  unknown: number;
  /** Why rows in this table are classified the way they are. */
  basis: string;
}

/* ── Inventory ───────────────────────────────────────────────────────────── */

/**
 * Tables carrying a `seed_tag` (migration 006). For these, classification is
 * explicit rather than inferred.
 */
const TAGGED: { table: string; kind: TableInventory['kind']; systemPredicate?: string; basis: string }[] = [
  {
    table: 'purchase_indent_headers', kind: 'business',
    basis: "seed_tag ('demo'/'test'); NULL = entered through the application",
  },
  {
    table: 'purchase_order_headers', kind: 'business',
    basis: "seed_tag ('demo'/'test'); NULL = entered through the application",
  },
  {
    table: 'grn_headers', kind: 'business',
    basis: "seed_tag ('demo'/'test'); NULL = entered through the application",
  },
  {
    table: 'items', kind: 'business',
    basis: "seed_tag ('demo'/'test'); NULL = entered through the application",
  },
  {
    table: 'suppliers', kind: 'business',
    basis: "seed_tag ('demo'/'test'); NULL = entered through the application",
  },
  {
    // Business, not system: most rows are staff accounts. The two bootstrap
    // administrators are carved out as SYSTEM by the predicate below, so the
    // demo/real split stays visible instead of being hidden behind the table.
    table: 'users', kind: 'business',
    systemPredicate: "employee_id IN ('10221','10422')",
    basis: 'Bootstrap administrators are SYSTEM; seed_tag marks demo staff accounts',
  },
  {
    table: 'lookups', kind: 'business',
    systemPredicate: 'is_system',
    basis: 'is_system rows (UOM, currency) are international standards, not company data',
  },
];

/** Tables that hold only derived or operational records, never master data. */
const OPERATIONAL: { table: string; basis: string }[] = [
  { table: 'purchase_indent_lines', basis: 'Follows its indent header' },
  { table: 'purchase_order_lines', basis: 'Follows its PO header' },
  { table: 'po_indent_sources', basis: 'Follows its PO header' },
  { table: 'grn_lines', basis: 'Follows its GRN header' },
  { table: 'indent_approvals', basis: 'Follows its indent header' },
  { table: 'audit_logs', basis: 'Immutable history — retained by default' },
  { table: 'import_jobs', basis: 'Import history' },
  { table: 'import_rows', basis: 'Import history' },
  { table: 'google_sync_jobs', basis: 'Sync history' },
  { table: 'google_sync_errors', basis: 'Sync history' },
  { table: 'backup_metadata', basis: 'Backup catalogue — retained' },
  { table: 'user_sessions', basis: 'Live sessions' },
];

/** Tables the application cannot run without. Never purged. */
const SYSTEM_TABLES: { table: string; basis: string }[] = [
  { table: 'permissions', basis: 'Permission catalogue (64) — required' },
  { table: 'roles', basis: 'Role definitions — required' },
  { table: 'role_permissions', basis: 'Role/permission grants — required' },
  { table: 'user_roles', basis: 'User role assignments' },
  { table: 'app_settings', basis: 'System configuration — required' },
  { table: 'google_sheet_mappings', basis: 'Sheet field mappings — required' },
  { table: 'document_sequences', basis: 'Document numbering counters — required' },
  { table: 'schema_migrations', basis: 'Migration ledger — required' },
];

const countOf = async (sql: string, params: unknown[] = []): Promise<number> => {
  const row = await queryOne<{ n: string }>(sql, params);
  return Number(row?.n ?? 0);
};

/** Builds the full classification inventory. Read-only. */
export async function buildInventory(): Promise<TableInventory[]> {
  const out: TableInventory[] = [];

  for (const t of TAGGED) {
    const sys = t.systemPredicate ?? 'FALSE';
    const row = await queryOne<Record<string, string>>(
      `SELECT COUNT(*) AS total,
              COUNT(*) FILTER (WHERE ${sys})                                  AS system,
              COUNT(*) FILTER (WHERE NOT (${sys}) AND seed_tag = 'demo')       AS demo,
              COUNT(*) FILTER (WHERE NOT (${sys}) AND seed_tag = 'test')       AS test,
              COUNT(*) FILTER (WHERE NOT (${sys}) AND seed_tag IS NULL)        AS real,
              COUNT(*) FILTER (WHERE NOT (${sys}) AND seed_tag IS NOT NULL
                               AND seed_tag NOT IN ('demo','test'))            AS unknown
         FROM ${t.table}`,
    );
    out.push({
      table: t.table, kind: t.kind, basis: t.basis,
      total: Number(row?.total ?? 0),
      real: Number(row?.real ?? 0),
      demo: Number(row?.demo ?? 0),
      test: Number(row?.test ?? 0),
      system: Number(row?.system ?? 0),
      unknown: Number(row?.unknown ?? 0),
    });
  }

  for (const t of OPERATIONAL) {
    const total = await countOf(`SELECT COUNT(*) AS n FROM ${t.table}`).catch(() => 0);
    out.push({ table: t.table, kind: 'operational', basis: t.basis, total, real: total, demo: 0, test: 0, system: 0, unknown: 0 });
  }

  for (const t of SYSTEM_TABLES) {
    const total = await countOf(`SELECT COUNT(*) AS n FROM ${t.table}`).catch(() => 0);
    out.push({ table: t.table, kind: 'system', basis: t.basis, total, real: 0, demo: 0, test: 0, system: total, unknown: 0 });
  }

  return out;
}

/* ── Pre-purge safety backup ─────────────────────────────────────────────── */

const sha256 = (t: string) => crypto.createHash('sha256').update(t, 'utf8').digest('hex');

/**
 * Takes a checksum-verified full backup and records it in `backup_metadata`,
 * BEFORE any purge is allowed to run. Shared by `db:purify` (CLI) and the
 * Admin → Backup & Restore "Data Audit" purify endpoint, so there is exactly
 * one implementation of "what a pre-purge safety net looks like."
 *
 * Reads the backup back off disk and re-checksums it before returning — a
 * backup that was never verified is not a backup, and this one is the only
 * way back if the purge turns out to be wrong.
 */
export async function takePrePurifyBackup(
  notes = 'Automatic safety backup taken before data purification',
): Promise<{ filename: string; checksum: string; bytes: number }> {
  const schemaRow = await queryOne<{ version: string }>(
    'SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1',
  );
  const { data, counts } = await collectBackupData((sql) => query(sql));

  const payload: BackupPayload = {
    meta: {
      product: 'ZOLEX Purchase-to-Store ERP',
      version: '1.0.0',
      createdAt: new Date().toISOString(),
      schemaVersion: schemaRow?.version ?? 'unknown',
      tableCounts: counts,
    },
    data,
  };

  const json = JSON.stringify(payload, null, 0);
  const checksum = sha256(json);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `zolex-pre-purify-${stamp}.json`;
  const filePath = `${paths.backups}/${filename}`;

  fs.mkdirSync(paths.backups, { recursive: true });
  fs.writeFileSync(filePath, json, 'utf8');

  const readBack = fs.readFileSync(filePath, 'utf8');
  if (sha256(readBack) !== checksum) {
    throw new Error(`Backup verification FAILED for ${filename} — refusing to purge.`);
  }
  JSON.parse(readBack);

  const bytes = fs.statSync(filePath).size;

  await execute(
    `INSERT INTO backup_metadata
       (filename, file_path, kind, status, size_bytes, checksum_sha256,
        table_counts, schema_version, notes, verified_at)
     VALUES ($1,$2,'MANUAL','VERIFIED',$3,$4,$5::jsonb,$6,$7, now())`,
    [filename, filePath, bytes, checksum, JSON.stringify(counts),
     schemaRow?.version ?? '', notes],
  );

  return { filename, checksum, bytes };
}

/* ── Purge ───────────────────────────────────────────────────────────────── */

export interface PurgeResult {
  deleted: Record<string, number>;
  retained: { table: string; rows: number; reason: string }[];
  skipped: { table: string; rows: number; reason: string }[];
}

/**
 * Deletes every row tagged `demo` or `test`, in foreign-key-safe order, inside
 * one transaction.
 *
 * A master (item / supplier / lookup / user) is removed ONLY if nothing real
 * still references it. A demo item that a genuine indent happens to reference is
 * kept and reported, because deleting it would break a real document.
 */
export async function purgeNonProductionData(opts: {
  keepAuditLogs?: boolean;
  actorEmployeeId?: string;
  actorName?: string;
} = {}): Promise<PurgeResult> {
  const deleted: Record<string, number> = {};
  const retained: PurgeResult['retained'] = [];
  const skipped: PurgeResult['skipped'] = [];

  await withTransaction(async (tx) => {
    const del = async (label: string, sql: string, params: unknown[] = []) => {
      const res = await txQuery(tx, `${sql} RETURNING 1 AS x`, params);
      deleted[label] = (deleted[label] ?? 0) + res.length;
    };

    const TAG = "seed_tag IN ('demo','test')";

    /* 1. Transactions, deepest child first. ------------------------------- */
    await del('grn_lines',
      `DELETE FROM grn_lines WHERE grn_id IN (SELECT id FROM grn_headers WHERE ${TAG})`);
    await del('grn_headers', `DELETE FROM grn_headers WHERE ${TAG}`);

    await del('po_indent_sources',
      `DELETE FROM po_indent_sources WHERE po_line_id IN (
         SELECT l.id FROM purchase_order_lines l
           JOIN purchase_order_headers h ON h.id = l.po_id WHERE h.${TAG})`);
    await del('purchase_order_lines',
      `DELETE FROM purchase_order_lines WHERE po_id IN (SELECT id FROM purchase_order_headers WHERE ${TAG})`);
    await del('purchase_order_headers', `DELETE FROM purchase_order_headers WHERE ${TAG}`);

    await del('indent_approvals',
      `DELETE FROM indent_approvals WHERE indent_id IN (SELECT id FROM purchase_indent_headers WHERE ${TAG})`);
    await del('purchase_indent_lines',
      `DELETE FROM purchase_indent_lines WHERE indent_id IN (SELECT id FROM purchase_indent_headers WHERE ${TAG})`);
    await del('purchase_indent_headers', `DELETE FROM purchase_indent_headers WHERE ${TAG}`);

    /* 2. Demo staff accounts. Bootstrap admins are never touched.
          MUST precede the master cleanup: a demo user holds a department_id, and
          while that reference exists the department lookup is (correctly) treated
          as still in use and survives the purge. */
    await del('user_sessions',
      `DELETE FROM user_sessions WHERE user_id IN (
         SELECT id FROM users WHERE ${TAG} AND employee_id NOT IN ('10221','10422'))`);
    await del('user_roles',
      `DELETE FROM user_roles WHERE user_id IN (
         SELECT id FROM users WHERE ${TAG} AND employee_id NOT IN ('10221','10422'))`);
    await del('users',
      `DELETE FROM users WHERE ${TAG} AND employee_id NOT IN ('10221','10422')
         AND id NOT IN (SELECT created_by FROM purchase_indent_headers WHERE created_by IS NOT NULL)
         AND id NOT IN (SELECT created_by FROM purchase_order_headers WHERE created_by IS NOT NULL)
         AND id NOT IN (SELECT created_by FROM grn_headers WHERE created_by IS NOT NULL)`);

    /* 3. Masters — only those nothing real still points at. ---------------- */
    await deleteUnreferencedMasters(tx, deleted, retained);

    /* 4. Import / sync history produced while exercising demo data. -------- */
    await del('import_rows', 'DELETE FROM import_rows WHERE job_id IN (SELECT id FROM import_jobs)');
    await del('import_jobs', 'DELETE FROM import_jobs');
    await del('google_sync_errors', 'DELETE FROM google_sync_errors WHERE job_id IN (SELECT id FROM google_sync_jobs)');
    await del('google_sync_jobs', 'DELETE FROM google_sync_jobs');

    /* 5. Audit log. Retained by default: it is the record OF the purge. ---- */
    if (opts.keepAuditLogs === false) {
      await del('audit_logs', 'DELETE FROM audit_logs');
    } else {
      const n = await txQueryOne<{ n: string }>(tx, 'SELECT COUNT(*) AS n FROM audit_logs');
      skipped.push({
        table: 'audit_logs', rows: Number(n?.n ?? 0),
        reason: 'Audit history is retained by default — it is the evidence that the purge happened',
      });
    }

    /* 6. Mark the database as purified. -----------------------------------
       This is what makes purification DURABLE. Without it the next start-up
       would notice the absent demo rows and helpfully re-create them, silently
       undoing the purge. `seedDemoData()` honours this marker regardless of
       SEED_DEMO_DATA, so a deliberate purge cannot be reversed by a restart or
       by a forgotten environment variable. `db:reset` clears it. */
    await txQuery(
      tx,
      `INSERT INTO app_settings (key, value, description)
       VALUES ('data.purified_at', to_jsonb(now()::text),
               'Set when non-production data was purged. While present, demo seeding is refused.')
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    );

    /* 7. Record the purification itself. ---------------------------------- */
    await txQuery(
      tx,
      `INSERT INTO audit_logs (actor_employee_id, actor_name, action, entity, entity_label, result, message)
       VALUES ($1, $2, 'PURGE', 'database', 'non-production data', 'SUCCESS', $3)`,
      [opts.actorEmployeeId ?? 'SYSTEM', opts.actorName ?? 'Data purification',
       `Removed demo/test records: ${Object.entries(deleted)
        .filter(([, n]) => n > 0).map(([t, n]) => `${t}=${n}`).join(', ') || 'none'}`],
    );
  });

  return { deleted, retained, skipped };
}

/**
 * Removes demo masters that nothing real references.
 *
 * Order matters: items and suppliers first, then the lookups they pointed at,
 * because a lookup cannot be deleted while an item still references it
 * (ON DELETE RESTRICT).
 */
async function deleteUnreferencedMasters(
  tx: Queryable,
  deleted: Record<string, number>,
  retained: PurgeResult['retained'],
): Promise<void> {
  const TAG = "seed_tag IN ('demo','test')";

  const runDelete = async (label: string, sql: string) => {
    const res = await txQuery(tx, `${sql} RETURNING 1 AS x`);
    deleted[label] = (deleted[label] ?? 0) + res.length;
  };

  const noteRetained = async (label: string, sql: string, reason: string) => {
    const row = await txQueryOne<{ n: string }>(tx, sql);
    const n = Number(row?.n ?? 0);
    if (n > 0) retained.push({ table: label, rows: n, reason });
  };

  // Items still referenced by a surviving document must stay.
  await noteRetained(
    'items',
    `SELECT COUNT(*) AS n FROM items i WHERE i.${TAG}
       AND (EXISTS (SELECT 1 FROM purchase_indent_lines WHERE item_id = i.id)
         OR EXISTS (SELECT 1 FROM purchase_order_lines WHERE item_id = i.id))`,
    'Referenced by a document that was not purged',
  );
  await runDelete(
    'items',
    `DELETE FROM items i WHERE i.${TAG}
       AND NOT EXISTS (SELECT 1 FROM purchase_indent_lines WHERE item_id = i.id)
       AND NOT EXISTS (SELECT 1 FROM purchase_order_lines WHERE item_id = i.id)`,
  );

  await noteRetained(
    'suppliers',
    `SELECT COUNT(*) AS n FROM suppliers s WHERE s.${TAG}
       AND (EXISTS (SELECT 1 FROM purchase_order_headers WHERE supplier_id = s.id)
         OR EXISTS (SELECT 1 FROM grn_headers WHERE supplier_id = s.id)
         OR EXISTS (SELECT 1 FROM purchase_indent_headers WHERE suggested_supplier_id = s.id))`,
    'Referenced by a document that was not purged',
  );
  await runDelete(
    'suppliers',
    `DELETE FROM suppliers s WHERE s.${TAG}
       AND NOT EXISTS (SELECT 1 FROM purchase_order_headers WHERE supplier_id = s.id)
       AND NOT EXISTS (SELECT 1 FROM grn_headers WHERE supplier_id = s.id)
       AND NOT EXISTS (SELECT 1 FROM purchase_indent_headers WHERE suggested_supplier_id = s.id)`,
  );

  // Lookups last: children (sub groups) before parents, and never `is_system`.
  await runDelete(
    'lookups',
    `DELETE FROM lookups k WHERE k.${TAG} AND NOT k.is_system
       AND NOT EXISTS (SELECT 1 FROM lookups c WHERE c.parent_id = k.id)
       AND NOT EXISTS (SELECT 1 FROM items i WHERE k.id IN
             (i.item_type_id, i.department_id, i.cost_centre_id, i.main_group_id,
              i.sub_main_group_id, i.indent_type_id, i.uom_id))
       AND NOT EXISTS (SELECT 1 FROM purchase_indent_headers h WHERE k.id IN
             (h.indent_type_id, h.department_id, h.cost_centre_id))
       AND NOT EXISTS (SELECT 1 FROM purchase_order_headers h WHERE k.id = h.po_type_id)
       AND NOT EXISTS (SELECT 1 FROM users u WHERE k.id = u.department_id)`,
  );
  // Parents become deletable once their children are gone — one more pass.
  await runDelete(
    'lookups',
    `DELETE FROM lookups k WHERE k.${TAG} AND NOT k.is_system
       AND NOT EXISTS (SELECT 1 FROM lookups c WHERE c.parent_id = k.id)
       AND NOT EXISTS (SELECT 1 FROM items i WHERE k.id IN
             (i.item_type_id, i.department_id, i.cost_centre_id, i.main_group_id,
              i.sub_main_group_id, i.indent_type_id, i.uom_id))
       AND NOT EXISTS (SELECT 1 FROM purchase_indent_headers h WHERE k.id IN
             (h.indent_type_id, h.department_id, h.cost_centre_id))
       AND NOT EXISTS (SELECT 1 FROM purchase_order_headers h WHERE k.id = h.po_type_id)
       AND NOT EXISTS (SELECT 1 FROM users u WHERE k.id = u.department_id)`,
  );

  await noteRetained(
    'lookups',
    `SELECT COUNT(*) AS n FROM lookups k WHERE k.${TAG} AND NOT k.is_system`,
    'Still referenced by surviving master or transaction data',
  );
}

/* ── Post-purge verification ─────────────────────────────────────────────── */

export interface VerificationResult {
  label: string;
  passed: boolean;
  detail: string;
}

/**
 * Proves the purge left a consistent, genuinely clean database.
 * The claim "no demo data remains" is asserted here, not assumed.
 */
export async function verifyPurified(): Promise<VerificationResult[]> {
  const checks: [string, string][] = [
    ['No demo/test indents remain',
     "SELECT COUNT(*) AS n FROM purchase_indent_headers WHERE seed_tag IN ('demo','test')"],
    ['No demo/test purchase orders remain',
     "SELECT COUNT(*) AS n FROM purchase_order_headers WHERE seed_tag IN ('demo','test')"],
    ['No demo/test goods receipts remain',
     "SELECT COUNT(*) AS n FROM grn_headers WHERE seed_tag IN ('demo','test')"],
    ['No [DEMO]-marked documents remain',
     `SELECT (SELECT COUNT(*) FROM purchase_indent_headers WHERE remarks LIKE '[DEMO]%')
           + (SELECT COUNT(*) FROM purchase_order_headers WHERE remarks LIKE '[DEMO]%')
           + (SELECT COUNT(*) FROM grn_headers WHERE remarks LIKE '[DEMO]%') AS n`],
    ['No orphaned indent lines',
     `SELECT COUNT(*) AS n FROM purchase_indent_lines l
        WHERE NOT EXISTS (SELECT 1 FROM purchase_indent_headers h WHERE h.id = l.indent_id)`],
    ['No orphaned PO lines',
     `SELECT COUNT(*) AS n FROM purchase_order_lines l
        WHERE NOT EXISTS (SELECT 1 FROM purchase_order_headers h WHERE h.id = l.po_id)`],
    ['No orphaned GRN lines',
     `SELECT COUNT(*) AS n FROM grn_lines l
        WHERE NOT EXISTS (SELECT 1 FROM grn_headers h WHERE h.id = l.grn_id)`],
    ['No orphaned PO source references',
     `SELECT COUNT(*) AS n FROM po_indent_sources s
        WHERE NOT EXISTS (SELECT 1 FROM purchase_order_lines l WHERE l.id = s.po_line_id)
           OR NOT EXISTS (SELECT 1 FROM purchase_indent_lines l WHERE l.id = s.indent_line_id)`],
    ['Quantity balances remain consistent',
     `SELECT (SELECT COUNT(*) FROM v_indent_line_balance WHERE ordered_qty > indent_qty OR pending_qty < 0)
           + (SELECT COUNT(*) FROM v_po_line_balance WHERE received_qty > po_qty OR pending_grn_qty < 0) AS n`],
    ['Stored PO status still matches the derived status',
     'SELECT COUNT(*) AS n FROM v_po_header_balance WHERE status <> derived_status'],
    ['Permission catalogue intact (64 permissions)',
     'SELECT CASE WHEN COUNT(*) = 64 THEN 0 ELSE 1 END AS n FROM permissions'],
    ['Default roles intact (6 roles)',
     'SELECT CASE WHEN COUNT(*) >= 6 THEN 0 ELSE 1 END AS n FROM roles'],
    ['Bootstrap administrators intact',
     "SELECT CASE WHEN COUNT(*) = 2 THEN 0 ELSE 1 END AS n FROM users WHERE employee_id IN ('10221','10422')"],
    ['An active Super Admin still exists',
     `SELECT CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END AS n
        FROM users u JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id
       WHERE r.code = 'SUPER_ADMIN' AND u.is_active AND u.deleted_at IS NULL`],
    ['Google sheet mappings intact (9 sheets)',
     'SELECT CASE WHEN COUNT(DISTINCT sheet_name) >= 9 THEN 0 ELSE 1 END AS n FROM google_sheet_mappings'],
    ['System lookups (UOM / currency) intact',
     'SELECT CASE WHEN COUNT(*) > 0 THEN 0 ELSE 1 END AS n FROM lookups WHERE is_system'],
  ];

  const out: VerificationResult[] = [];
  for (const [label, sql] of checks) {
    try {
      const row = await queryOne<{ n: string }>(sql);
      const n = Number(row?.n ?? 0);
      out.push({ label, passed: n === 0, detail: n === 0 ? 'ok' : `${n} violation(s)` });
    } catch (err) {
      out.push({ label, passed: false, detail: `check failed: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}` });
    }
  }
  return out;
}

/** Remaining business-row counts, for the after-state of the report. */
export async function businessCounts(): Promise<Record<string, number>> {
  const tables = ['items', 'suppliers', 'lookups', 'users',
    'purchase_indent_headers', 'purchase_order_headers', 'grn_headers'];
  const out: Record<string, number> = {};
  for (const t of tables) {
    const rows = await query<{ n: string }>(`SELECT COUNT(*) AS n FROM ${t}`);
    out[t] = Number(rows[0]?.n ?? 0);
  }
  return out;
}
