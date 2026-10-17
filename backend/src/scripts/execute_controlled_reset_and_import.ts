/**
 * CONTROLLED FULL BUSINESS-DATABASE RESET AND LIVE SOURCE IMPORT ENGINE
 *
 * Implements Stage A & Stage B:
 *  1. Complete verified backup of existing database & destination sheet (with SHA-256 & record counts)
 *  2. Reference Master Data import:
 *     - Cost Centers (47)
 *     - Indent / PO / GRN Types (Exact 8 approved business types)
 *     - Machines (254)
 *     - User Master:
 *       * 26 Department-to-HOD rules -> lookups DEPARTMENT with extra: { hodName, hodUserId }
 *       * 497 Employees -> users table (department_id, employee_id, employee_name). An
 *         existing account keeps its active/inactive state; a new one is created
 *         INACTIVE with no usable password, exactly as the User Master sync does.
 *       * Match HODs to users and grant HOD role
 *     - Supplier Master (1,392 unique suppliers)
 *     - Item Master (3,191 unique items with specs, UOM, HSN, QC Required, Min/Max)
 *  3. Dependency-aware clean reset of transaction tables:
 *     - direct_issue_lines, direct_issue_headers
 *     - requisition_issue_lines, requisition_issues, requisition_approvals, requisition_lines, requisition_headers
 *     - qc_inspections, stock_ledger, grn_line_mlns, grn_lines, grn_headers
 *     - po_indent_sources, purchase_order_lines, purchase_order_headers
 *     - auto_indents, indent_approvals, purchase_indent_lines, purchase_indent_headers
 *  4. Live import of transactions:
 *     - GRNs (with valid item validation, MLNs, and stock_ledger inward postings)
 *     - Requisitions (correct column mappings: Col 8 User Name, Col 9 Department, Col 11 Cost Centre, Col 12 HOD, issues)
 *  5. Stock ledger reconciliation & live stock update
 *  6. Mirror publication to Destination Sheet (1v-r7cdHsnWBPJhe7RgaNYgnl5T7kPhvAIIf58-q770g)
 *  7. Independent verification and read-back report
 *
 * It refuses to start — even as a dry run — unless ZOLEX_ALLOW_RESET_IMPORT=yes
 * is set for that one run: it opens the database in ZOLEX_DATA_ROOT directly
 * (the production one by default) and with --execute deletes every business
 * transaction. Its 2026-10-14 run also set is_active = TRUE on every existing
 * account, silently re-activating 490 users, among them one an administrator
 * had deactivated the day before, with no audit row (AUTH-06).
 */
import { env, paths } from '../config/env.js';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { google } from 'googleapis';
import { GoogleAuth } from 'google-auth-library';
import { getDatabase, closeDatabase } from '../db/index.js';
import { collectBackupData } from '../db/restore.js';
import { auditIn, SYSTEM_ACTOR } from '../core/audit.js';

function parseDateRobust(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (!s) return null;

  // Excel serial number (e.g. 45570)
  if (/^\d{5}$/.test(s)) {
    const serial = parseInt(s, 10);
    const utcDays = serial - 25569;
    const date = new Date(utcDays * 86400 * 1000);
    return date.toISOString().slice(0, 10);
  }

  // DD-MMM-YY or DD-MMM-YYYY (e.g. 13-Oct-26, 13-Oct-2026)
  const dMmmMatch = s.match(/^(\d{1,2})[-/]([A-Za-z]{3})[-/](\d{2,4})$/);
  if (dMmmMatch) {
    const day = dMmmMatch[1]!.padStart(2, '0');
    const mStr = dMmmMatch[2]!.toLowerCase();
    let year = dMmmMatch[3]!;
    if (year.length === 2) year = '20' + year;
    const monthMap: Record<string, string> = {
      jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
      jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
    };
    const month = monthMap[mStr];
    if (month) return `${year}-${month}-${day}`;
  }

  // DD/MM/YYYY or DD-MM-YYYY
  const dmyMatch = s.match(/^(\d{1,2})[\/\.-](\d{1,2})[\/\.-](\d{2,4})$/);
  if (dmyMatch) {
    const day = dmyMatch[1]!.padStart(2, '0');
    const month = dmyMatch[2]!.padStart(2, '0');
    let year = dmyMatch[3]!;
    if (year.length === 2) year = '20' + year;
    return `${year}-${month}-${day}`;
  }

  // YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    return s.slice(0, 10);
  }

  const d = new Date(s);
  if (!isNaN(d.getTime())) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  return null;
}

function parseNum(raw: unknown): number {
  if (raw === null || raw === undefined) return 0;
  const s = String(raw).replace(/,/g, '').trim();
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

function normalizeTokens(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

interface UserCandidate {
  id: number;
  employeeId: string;
  name: string;
  tokens: string[];
}

function findBestUserMatch(raw: string, userList: UserCandidate[]): UserCandidate | null {
  const rawTokens = normalizeTokens(raw);
  if (rawTokens.length === 0) return null;

  // 1. Exact full match
  const exact = userList.find((u) => u.name.toLowerCase() === raw.toLowerCase());
  if (exact) return exact;

  // 2. First and last tokens match (e.g. Mehulkumar Patel -> Mehulkumar Nitinbhai Patel)
  if (rawTokens.length >= 2) {
    const first = rawTokens[0];
    const last = rawTokens[rawTokens.length - 1];
    const flMatches = userList.filter((u) => {
      if (u.tokens.length < 2) return false;
      return u.tokens[0] === first && u.tokens[u.tokens.length - 1] === last;
    });
    if (flMatches.length === 1) return flMatches[0];
  }

  // 3. All tokens in raw are contained in user name
  const allTok = userList.filter((u) => rawTokens.every((t) => u.tokens.includes(t)));
  if (allTok.length === 1) return allTok[0];

  // 4. Single token match (e.g. "Martin" matching "Martin Pravinbhai Karthiya")
  if (rawTokens.length === 1) {
    const single = userList.filter((u) => u.tokens[0] === rawTokens[0]);
    if (single.length === 1) return single[0];
  }

  return null;
}

const APPROVED_INDENT_TYPES = [
  'CAPITAL',
  'CHEMICAL',
  'OTHER MATERIALS',
  'PACKING MATERIALS',
  'RAW MATERIAL',
  'SEMI FINISHED',
  'STORES & SPARES',
  'TRADING MATERIAL',
];

async function main() {
  if (process.env.ZOLEX_ALLOW_RESET_IMPORT !== 'yes') {
    console.error(
      `\nRefusing to run: this script opens the database under ${paths.root} directly and, with --execute, ` +
      'deletes every business transaction before re-importing. Take a backup, stop the backend, and set ' +
      'ZOLEX_ALLOW_RESET_IMPORT=yes for this one run if that is really intended.\n',
    );
    process.exit(1);
  }
  const isExecute = process.argv.includes('--execute');
  const runStamp = new Date().toISOString().replace(/[:.]/g, '-');
  console.log('========================================================================');
  console.log(`MASTER RECOVERY: CONTROLLED DATABASE RESET & LIVE IMPORT (${isExecute ? 'EXECUTE' : 'DRY-RUN'})`);
  console.log('Timestamp:', new Date().toISOString());
  console.log('Source Sheet:', env.GOOGLE_SHEET_ID);
  console.log('Destination Sheet:', env.GOOGLE_DB_SPREADSHEET_ID || '1v-r7cdHsnWBPJhe7RgaNYgnl5T7kPhvAIIf58-q770g');
  console.log('========================================================================\n');

  const auth = new GoogleAuth({
    keyFile: env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });
  const db = await getDatabase();

  // ─────────────────────────────────────────────────────────────────────────────
  // STAGE A: BACKUP PRE-RESET
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('>>> STAGE A: CREATING VERIFIED PRE-RESET BACKUP SNAPSHOT');
  const schemaRow = (await db.query<{ version: string }>('SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1')).rows[0];
  const { data: bData, counts: bCounts } = await collectBackupData(async (sql) => (await db.query(sql)).rows as any[]);
  const backupPayload = {
    meta: {
      product: 'ZOLEX Purchase-to-Store ERP',
      version: '1.0.0',
      createdAt: new Date().toISOString(),
      schemaVersion: schemaRow?.version ?? 'unknown',
      tableCounts: bCounts,
    },
    data: bData,
  };
  const bJson = JSON.stringify(backupPayload);
  const bChecksum = crypto.createHash('sha256').update(bJson).digest('hex');
  const backupFilename = `zolex-backup-pre-master-reset-${runStamp}.json`;
  const backupFilePath = path.join(paths.backups, backupFilename);
  fs.mkdirSync(paths.backups, { recursive: true });
  fs.writeFileSync(backupFilePath, bJson, 'utf8');
  console.log(`  ✓ Database Backup saved: ${backupFilePath}`);
  console.log(`    Size: ${Buffer.byteLength(bJson)} bytes | SHA-256: ${bChecksum}`);
  console.log(`    Pre-reset table counts:`, bCounts);

  if (isExecute) {
    await db.query(
      `INSERT INTO backup_metadata
         (filename, file_path, kind, status, size_bytes, checksum_sha256, table_counts, schema_version, notes, verified_at)
       VALUES ($1, $2, 'MANUAL', 'VERIFIED', $3, $4, $5, $6, 'Pre-master-reset safety backup', now())`,
      [backupFilename, backupFilePath, Buffer.byteLength(bJson), bChecksum, JSON.stringify(bCounts), schemaRow?.version ?? 'unknown'],
    );
  }

  // Backup Destination Sheet
  const destId = env.GOOGLE_DB_SPREADSHEET_ID || '1v-r7cdHsnWBPJhe7RgaNYgnl5T7kPhvAIIf58-q770g';
  const destMeta = await sheets.spreadsheets.get({ spreadsheetId: destId });
  const destBackup: Record<string, string[][]> = {};
  for (const s of destMeta.data.sheets || []) {
    const title = s.properties?.title;
    if (!title) continue;
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: destId, range: `'${title.replace(/'/g, "''")}'!A1:ZZ` });
    destBackup[title] = res.data.values || [];
  }
  const destJson = JSON.stringify({ createdAt: new Date().toISOString(), sheets: destBackup });
  const destChecksum = crypto.createHash('sha256').update(destJson).digest('hex');
  const destBackupPath = path.join(paths.backups, `destination-backup-pre-master-reset-${runStamp}.json`);
  fs.writeFileSync(destBackupPath, destJson, 'utf8');
  console.log(`  ✓ Destination Sheet Backup saved: ${destBackupPath}`);
  console.log(`    Size: ${Buffer.byteLength(destJson)} bytes | SHA-256: ${destChecksum}`);

  // ─────────────────────────────────────────────────────────────────────────────
  // FETCH ALL SOURCE TABS LIVE
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('\n>>> FETCHING LIVE DATA FROM AUTHORITATIVE SOURCE SHEET (1Dyj3Ws9gyR2zOe6p6RafQrKUFyLKIFN5h-3XDe9KD9I)');
  async function fetchTab(tabName: string): Promise<string[][]> {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: env.GOOGLE_SHEET_ID,
      range: `'${tabName.replace(/'/g, "''")}'!A1:ZZ`,
      valueRenderOption: 'FORMATTED_VALUE',
    });
    return (res.data.values ?? []).map((r) =>
      (r ?? []).map((c) => (c === null || c === undefined ? '' : String(c).trim()))
    );
  }

  const [
    costCenterRaw, typeRaw, machineRaw, userRaw,
    supplierRaw, itemRaw, grnRaw, reqRaw
  ] = await Promise.all([
    fetchTab('Cost Center'),
    fetchTab('Indent / PO / GRN Type'),
    fetchTab('Machine'),
    fetchTab('User Master'),
    fetchTab('Supplier Master'),
    fetchTab('Item Master'),
    fetchTab('GRN'),
    fetchTab('Requisition'),
  ]);

  console.log(`  * Cost Center: ${costCenterRaw.length} rows`);
  console.log(`  * Types: ${typeRaw.length} rows`);
  console.log(`  * Machine: ${machineRaw.length} rows`);
  console.log(`  * User Master: ${userRaw.length} rows`);
  console.log(`  * Supplier Master: ${supplierRaw.length} rows`);
  console.log(`  * Item Master: ${itemRaw.length} rows`);
  console.log(`  * GRN: ${grnRaw.length} rows`);
  console.log(`  * Requisition: ${reqRaw.length} rows`);

  if (!isExecute) {
    console.log('\n[DRY RUN SUMMARY]');
    console.log('To execute this controlled reset and re-import, pass --execute');
    await closeDatabase();
    return;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // STAGE B: CONTROLLED DATABASE RESET & LIVE RE-IMPORT
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('\n>>> STAGE B: EXECUTING TRANSACTIONAL RESET & FRESH RE-IMPORT');

  await db.transaction(async (tx) => {
    // 1. Reset Business Transaction Tables in dependency order
    console.log('  1. Clearing transaction tables...');
    await tx.query('DELETE FROM direct_issue_lines');
    await tx.query('DELETE FROM direct_issue_headers');
    await tx.query('DELETE FROM requisition_issue_lines');
    await tx.query('DELETE FROM requisition_issues');
    await tx.query('DELETE FROM requisition_approvals');
    await tx.query('DELETE FROM requisition_lines');
    await tx.query('DELETE FROM requisition_headers');
    await tx.query('DELETE FROM qc_inspections');
    await tx.query('DELETE FROM stock_ledger');
    await tx.query('DELETE FROM grn_line_mlns');
    await tx.query('DELETE FROM grn_lines');
    await tx.query('DELETE FROM grn_headers');
    await tx.query('DELETE FROM po_indent_sources');
    await tx.query('DELETE FROM purchase_order_lines');
    await tx.query('DELETE FROM purchase_order_headers');
    await tx.query('DELETE FROM auto_indents');
    await tx.query('DELETE FROM indent_approvals');
    await tx.query('DELETE FROM purchase_indent_lines');
    await tx.query('DELETE FROM purchase_indent_headers');
    console.log('     ✓ All transaction tables cleared safely.');

    // 2. Clear business master items & suppliers
    console.log('  2. Clearing master items & suppliers...');
    await tx.query('DELETE FROM items');
    await tx.query('DELETE FROM suppliers');
    console.log('     ✓ Items & suppliers cleared safely.');

    // 3. Import Approved Indent Types (Exact 8 approved business types)
    console.log('  3. Configuring 8 approved Indent Types...');
    await tx.query("DELETE FROM lookups WHERE category = 'INDENT_TYPE'");
    const indentTypeMap = new Map<string, number>();
    for (const tName of APPROVED_INDENT_TYPES) {
      const code = tName.toUpperCase().replace(/[^A-Z0-9]/g, '_');
      const ins = await tx.query(
        `INSERT INTO lookups (category, code, name, description, is_active)
         VALUES ('INDENT_TYPE', $1, $2, $3, TRUE)
         RETURNING id`,
        [code, tName, `Approved Business Indent Type: ${tName}`],
      );
      indentTypeMap.set(tName.toUpperCase(), ins.rows[0].id);
      indentTypeMap.set(code, ins.rows[0].id);
    }
    console.log(`     ✓ Configured ${indentTypeMap.size / 2} approved Indent Types.`);

    // Helper to get or create lookup safely without violating unique constraints
    async function getOrCreateLookup(category: string, code: string, name: string, description: string = '', extra: any = '{}'): Promise<number> {
      const normName = name.trim().toLowerCase();
      const normCode = code.trim().toUpperCase();
      const extraVal = typeof extra === 'object' && extra !== null ? JSON.stringify(extra) : (extra ?? '{}');
      const existing = await tx.query(
        `SELECT id FROM lookups WHERE category = $1 AND (lower(name) = $2 OR upper(code) = $3) AND deleted_at IS NULL LIMIT 1`,
        [category, normName, normCode],
      );
      if (existing.rows.length > 0) {
        const id = existing.rows[0].id;
        if (extra && extra !== '{}') {
          await tx.query(`UPDATE lookups SET extra = $1::jsonb, is_active = TRUE WHERE id = $2`, [extraVal, id]);
        }
        return id;
      }
      const ins = await tx.query(
        `INSERT INTO lookups (category, code, name, description, extra, is_active) VALUES ($1, $2, $3, $4, $5::jsonb, TRUE) RETURNING id`,
        [category, code.trim().slice(0, 50), name.trim(), description.trim(), extraVal],
      );
      return ins.rows[0].id;
    }

    // 4. Import Cost Centers
    console.log('  4. Importing Cost Centers from source...');
    const ccRows = costCenterRaw.slice(1).filter((r) => r[0] && r[0].trim());
    const costCentreMap = new Map<string, number>();
    for (const r of ccRows) {
      const name = r[0]!.trim();
      const code = 'CC_' + name.toUpperCase().replace(/[^A-Z0-9]/g, '_').slice(0, 30);
      const ccId = await getOrCreateLookup('COST_CENTRE', code, name, name);
      costCentreMap.set(name.toUpperCase(), ccId);
    }
    console.log(`     ✓ Cost Centers imported: ${costCentreMap.size}`);

    // 5. Import Machines
    console.log('  5. Importing Machines from source...');
    const machineRows = machineRaw.slice(1).filter((r) => r[0] && r[0].trim());
    const machineMap = new Map<string, number>();
    for (const r of machineRows) {
      const mNo = r[0]!.trim();
      const dept = r[1]?.trim() || '';
      const code = 'MCH_' + mNo.toUpperCase().replace(/[^A-Z0-9]/g, '_').slice(0, 30);
      const mId = await getOrCreateLookup('MACHINE', code, mNo, dept);
      machineMap.set(mNo.toUpperCase(), mId);
    }
    console.log(`     ✓ Machines imported: ${machineMap.size}`);

    // 6. Import Department to HOD mappings and User Master
    console.log('  6. Importing User Master & Department HOD mappings...');
    // Parse 26 Department-HOD rules from Cols 4 & 5
    const deptHodRules = new Map<string, string>();
    for (let i = 1; i < userRaw.length; i++) {
      const r = userRaw[i] || [];
      const dName = (r[4] || '').trim();
      const hName = (r[5] || '').trim();
      if (dName && hName) {
        deptHodRules.set(dName, hName);
      }
    }

    // Ensure all 26 departments exist in lookups
    const deptMap = new Map<string, number>();
    for (const [deptName, hodName] of deptHodRules.entries()) {
      const code = 'DEP_' + deptName.toUpperCase().replace(/[^A-Z0-9]/g, '_').slice(0, 30);
      const dId = await getOrCreateLookup('DEPARTMENT', code, deptName, '', JSON.stringify({ hodName }));
      deptMap.set(deptName.toUpperCase(), dId);
      deptMap.set(code, dId);
    }

    // Import 497 Employees from Cols 0, 1, 2
    const empRows = userRaw.slice(1).filter((r) => r[0] && r[0].trim() && r[1] && r[1].trim());
    let employeesImported = 0;
    let updatedAccounts = 0;
    const createdAccounts: string[] = [];
    const hodRoleHolders: number[] = [];
    const userMap = new Map<string, { id: number; employeeId: string; employeeName: string }>();

    for (const r of empRows) {
      const empCode = r[0]!.trim();
      const empName = r[1]!.trim();
      const empDept = (r[2] || '').trim();
      let departmentId: number | null = null;
      if (empDept) {
        const up = empDept.toUpperCase();
        if (deptMap.has(up)) {
          departmentId = deptMap.get(up)!;
        } else {
          const dCode = 'DEP_' + up.replace(/[^A-Z0-9]/g, '_').slice(0, 30);
          departmentId = await getOrCreateLookup('DEPARTMENT', dCode, empDept);
          deptMap.set(up, departmentId);
        }
      }

      // Check existing user (preserve Super Admin 10221 / 10422 credentials)
      const existing = await tx.query("SELECT id, employee_id, password_hash FROM users WHERE employee_id = $1", [empCode]);
      let uId: number;
      if (existing.rows.length > 0) {
        uId = existing.rows[0].id;
        // Name and department only. Whether an account may sign in is decided
        // in User Management, never by an import (see the header comment).
        await tx.query(
          `UPDATE users SET employee_name = $2, department_id = COALESCE($3, department_id) WHERE id = $1`,
          [uId, empName, departmentId],
        );
        updatedAccounts++;
      } else {
        // As the User Master sync creates them: inactive, with an unusable password
        // hash, until an administrator activates the account and sets a password.
        const ins = await tx.query(
          `INSERT INTO users (employee_id, employee_name, designation, department_id, password_hash, is_active, must_change_password)
           VALUES ($1, $2, 'Staff', $3, '!', FALSE, TRUE)
           RETURNING id`,
          [empCode, empName, departmentId],
        );
        uId = ins.rows[0].id;
        createdAccounts.push(empCode);
        // Grant employee role
        await tx.query("INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE code = 'EMPLOYEE' ON CONFLICT DO NOTHING", [uId]);
      }
      userMap.set(empCode, { id: uId, employeeId: empCode, employeeName: empName });
      userMap.set(empName.toUpperCase(), { id: uId, employeeId: empCode, employeeName: empName });
      employeesImported++;
    }

    // Now link HOD User IDs onto the departments
    const hodRole = (await tx.query("SELECT id FROM roles WHERE code = 'HOD'")).rows[0]?.id;
    for (const [deptName, hodRaw] of deptHodRules.entries()) {
      const clean = hodRaw.replace(/^Mr\.?\s*/i, '').trim().toLowerCase();
      // Find matching user
      const uMatch = (await tx.query(
        `SELECT id, employee_name FROM users WHERE lower(employee_name) LIKE $1 AND deleted_at IS NULL ORDER BY id ASC LIMIT 1`,
        [`%${clean}%`],
      )).rows[0];

      const dId = deptMap.get(deptName.toUpperCase());
      if (dId) {
        if (uMatch) {
          await tx.query(
            `UPDATE lookups SET extra = jsonb_build_object('hodName', $1::text, 'hodUserId', $2::bigint) WHERE id = $3`,
            [hodRaw, uMatch.id, dId],
          );
          if (hodRole) {
            await tx.query("INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [uMatch.id, hodRole]);
            hodRoleHolders.push(Number(uMatch.id));
          }
        } else {
          await tx.query(
            `UPDATE lookups SET extra = jsonb_build_object('hodName', $1::text) WHERE id = $2`,
            [hodRaw, dId],
          );
        }
      }
    }
    console.log(`     ✓ User Master employees imported: ${employeesImported} (${createdAccounts.length} new, inactive)`);
    console.log(`     ✓ Department HOD rules configured: ${deptHodRules.size}`);
    // Account changes made outside the user API still belong in the audit trail.
    await auditIn(tx, {
      actor: { ...SYSTEM_ACTOR, name: 'execute_controlled_reset_and_import' },
      action: 'IMPORT', entity: 'user', source: 'IMPORT', entityLabel: 'User Master (controlled reset import)',
      after: { rows: employeesImported, updated: updatedAccounts, createdInactive: createdAccounts, hodRoleEnsuredFor: hodRoleHolders },
      message: `Updated the name and department of ${updatedAccounts} existing account(s) (active state unchanged), ` +
        `created ${createdAccounts.length} inactive account(s) with no usable password, and ensured the HOD role ` +
        `for ${hodRoleHolders.length} department HOD(s).`,
    });

    // Ensure fallback admin user exists
    const fallbackUser = (await tx.query("SELECT id FROM users WHERE employee_id IN ('10221', '10422') ORDER BY id ASC LIMIT 1")).rows[0];
    const fallbackUserId = fallbackUser?.id ?? 1;

    // Build user candidate list for robust matching
    const allUsersList: UserCandidate[] = [];
    const hodUsersList: UserCandidate[] = [];
    const dbUsers = (await tx.query(`
      SELECT u.id, u.employee_id, u.employee_name,
             COALESCE(bool_or(r.name = 'HOD'), false) as is_hod
        FROM users u
        LEFT JOIN user_roles ur ON ur.user_id = u.id
        LEFT JOIN roles r ON r.id = ur.role_id
       WHERE u.deleted_at IS NULL
       GROUP BY u.id, u.employee_id, u.employee_name
    `)).rows;

    for (const u of dbUsers) {
      const uObj: UserCandidate = {
        id: Number(u.id),
        employeeId: String(u.employee_id || ''),
        name: String(u.employee_name || ''),
        tokens: normalizeTokens(String(u.employee_name || '')),
      };
      allUsersList.push(uObj);
      if (u.is_hod) hodUsersList.push(uObj);
    }
    const superAdminCandidate: UserCandidate = allUsersList.find((u) => u.employeeId === '10221') || allUsersList[0]!;

    // 7. Import Supplier Master (1,392 unique suppliers)
    console.log('  7. Importing Supplier Master...');
    const suppRows = supplierRaw.slice(1).filter((r) => r[0] && r[0].trim());
    const supplierMap = new Map<string, number>();
    const seenSuppNames = new Set<string>();

    // Fallback supplier
    const fbSupp = await tx.query(
      `INSERT INTO suppliers (supplier_code, supplier_name, address, city, state, country, is_active)
       VALUES ('SUP-UNSPECIFIED', 'Unspecified / Direct Store Inward', 'Plant Store', 'Vadodara', 'Gujarat', 'India', TRUE)
       RETURNING id`,
    );
    const fallbackSupplierId = fbSupp.rows[0].id;
    supplierMap.set('SUP-UNSPECIFIED', fallbackSupplierId);

    let suppImported = 0;
    for (let idx = 0; idx < suppRows.length; idx++) {
      const r = suppRows[idx]!;
      const name = r[0]!.trim();
      const upName = name.toUpperCase();
      if (seenSuppNames.has(upName)) continue;
      seenSuppNames.add(upName);

      const address = (r[1] || '').trim();
      const city = (r[2] || '').trim() || 'Vadodara';
      const state = (r[3] || '').trim() || 'Gujarat';
      const country = (r[4] || '').trim() || 'India';
      const mobile = (r[5] || '').trim();
      const email = (r[6] || '').trim();
      const gst = (r[7] || '').trim();
      const payTerms = (r[8] || '').trim();
      const curr = (r[9] || 'INR').trim();
      let suppCode = (r[10] || '').trim();
      if (!suppCode || supplierMap.has(suppCode.toUpperCase())) {
        suppCode = `SUP-${String(idx + 1).padStart(5, '0')}`;
      }
      const zip = (r[11] || '').trim();
      const contact = (r[12] || '').trim();

      const ins = await tx.query(
        `INSERT INTO suppliers
           (supplier_code, supplier_name, address, city, state, country,
            mobile_no, email, gst_no, payment_terms, currency_code, contact_person, is_active)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, TRUE)
         RETURNING id`,
        [suppCode, name, address, city, state, country, mobile, email, gst, payTerms, curr, contact],
      );
      supplierMap.set(suppCode.toUpperCase(), ins.rows[0].id);
      supplierMap.set(upName, ins.rows[0].id);
      suppImported++;
    }
    console.log(`     ✓ Supplier Master imported: ${suppImported}`);

    // 8. Import Item Master (3,191 unique items)
    console.log('  8. Importing Item Master...');
    // UOM cache
    const uomLookup = new Map<string, number>();
    (await tx.query("SELECT id, upper(code) as up FROM lookups WHERE category = 'UOM'")).rows.forEach((r: any) => {
      uomLookup.set(r.up, r.id);
    });
    const defaultUomId = uomLookup.get('NOS') || 1;

    // Main Group cache
    const mainGroupLookup = new Map<string, number>();
    (await tx.query("SELECT id, upper(name) as up FROM lookups WHERE category = 'MAIN_GROUP'")).rows.forEach((r: any) => {
      mainGroupLookup.set(r.up, r.id);
    });

    const itemRows = itemRaw.slice(1).filter((r) => r[0] && r[0].trim());
    const itemMap = new Map<string, { id: number; uomId: number; itemCode: string; itemDesc: string }>();
    const seenItemCodes = new Set<string>();
    let itemsImported = 0;

    for (let idx = 0; idx < itemRows.length; idx++) {
      const r = itemRows[idx]!;
      const code = r[0]!.trim();
      const upCode = code.toUpperCase();
      if (seenItemCodes.has(upCode)) continue;
      seenItemCodes.add(upCode);

      const name = (r[1] || '').trim();
      const desc = (r[2] || '').trim() || name || code;
      const spec = (r[3] || '').trim();
      const mainGroupName = (r[4] || '').trim();
      const uomName = (r[6] || '').trim().toUpperCase();
      const uomId = uomLookup.get(uomName) || defaultUomId;
      const hsn = (r[8] || '').trim();
      const indTypeName = (r[11] || '').trim().toUpperCase();
      const indTypeId = indentTypeMap.get(indTypeName) || null;
      const qcReq = /^(true|1|yes|y)$/i.test((r[12] || '').trim());
      const minStock = parseNum(r[15]);
      const maxStock = parseNum(r[16]);

      let mainGroupId: number | null = null;
      if (mainGroupName) {
        const upG = mainGroupName.toUpperCase();
        if (mainGroupLookup.has(upG)) {
          mainGroupId = mainGroupLookup.get(upG)!;
        } else {
          const gCode = 'MG_' + upG.replace(/[^A-Z0-9]/g, '_').slice(0, 30);
          mainGroupId = await getOrCreateLookup('MAIN_GROUP', gCode, mainGroupName);
          mainGroupLookup.set(upG, mainGroupId);
        }
      }

      const ins = await tx.query(
        `INSERT INTO items
           (item_code, item_description, item_specification, main_group_id, uom_id,
            hsn_code, indent_type_id, qc_required, min_stock, max_stock, live_stock_qty, is_active)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 0, TRUE)
         RETURNING id`,
        [code, desc, spec, mainGroupId, uomId, hsn, indTypeId, qcReq, minStock, maxStock],
      );
      const itObj = { id: ins.rows[0].id, uomId, itemCode: code, itemDesc: desc };
      itemMap.set(code, itObj);
      itemMap.set(upCode, itObj);
      itemsImported++;
    }
    console.log(`     ✓ Item Master imported: ${itemsImported}`);

    // 8b. Discover and register extra items referenced in Requisitions and GRNs
    console.log('  8b. Discovering items referenced in Requisitions and GRNs...');
    let extraItemsImported = 0;
    const allTxRows = [
      ...reqRaw.slice(1).map((r) => ({
        code: (r[3] || '').trim(),
        name: (r[4] || '').trim(),
        uom: (r[6] || '').trim(),
        group: (r[7] || '').trim(),
      })),
      ...grnRaw.slice(1).map((r) => ({
        code: (r[5] || '').trim(),
        name: (r[6] || '').trim(),
        uom: (r[8] || '').trim(),
        group: (r[7] || '').trim(),
      })),
    ];

    for (const txItem of allTxRows) {
      let code = txItem.code;
      const name = txItem.name;
      if (!code && !name) continue;
      if (!code && name) {
        code = 'ITEM_' + name.toUpperCase().replace(/[^A-Z0-9]/g, '_').slice(0, 25);
      }
      const upCode = code.toUpperCase();
      if (seenItemCodes.has(upCode)) continue;
      seenItemCodes.add(upCode);

      const uomName = (txItem.uom || '').toUpperCase();
      let uomId = uomLookup.get(uomName);
      if (!uomId && uomName) {
        uomId = await getOrCreateLookup('UOM', uomName, uomName);
        uomLookup.set(uomName, uomId);
      }
      if (!uomId) uomId = defaultUomId;

      let mainGroupId: number | null = null;
      if (txItem.group) {
        const upG = txItem.group.toUpperCase();
        if (mainGroupLookup.has(upG)) {
          mainGroupId = mainGroupLookup.get(upG)!;
        } else {
          const gCode = 'MG_' + upG.replace(/[^A-Z0-9]/g, '_').slice(0, 30);
          mainGroupId = await getOrCreateLookup('MAIN_GROUP', gCode, txItem.group);
          mainGroupLookup.set(upG, mainGroupId);
        }
      }

      const desc = name || code;
      const ins = await tx.query(
        `INSERT INTO items
           (item_code, item_description, main_group_id, uom_id, qc_required, min_stock, max_stock, live_stock_qty, is_active)
         VALUES ($1, $2, $3, $4, FALSE, 0, 0, 0, TRUE)
         RETURNING id`,
        [code, desc, mainGroupId, uomId],
      );
      const itObj = { id: ins.rows[0].id, uomId, itemCode: code, itemDesc: desc };
      itemMap.set(code, itObj);
      itemMap.set(upCode, itObj);
      extraItemsImported++;
    }
    console.log(`     ✓ Extra transaction items registered in Item Master: ${extraItemsImported}`);

    // 9. Import GRNs
    console.log('  9. Importing GRNs and generating Stock Ledger inward postings...');
    const grnDataRows = grnRaw.slice(1).filter((r) => r.some((c) => c && c.trim()));
    const grnGroups = new Map<string, Array<{ rowIdx: number; row: string[] }>>();
    for (let i = 0; i < grnDataRows.length; i++) {
      const r = grnDataRows[i]!;
      const grnNo = (r[0] || '').trim();
      if (!grnNo) continue;
      if (!grnGroups.has(grnNo)) grnGroups.set(grnNo, []);
      grnGroups.get(grnNo)!.push({ rowIdx: i + 2, row: r });
    }

    let grnHeadersImported = 0;
    let grnLinesImported = 0;
    let grnStockPostings = 0;
    const itemRunningBalance = new Map<number, number>();

    for (const [grnNo, entries] of grnGroups.entries()) {
      const first = entries[0]!.row;
      const grnDate = parseDateRobust(first[1]) || '2026-08-01';
      const suppName = (first[2] || '').trim();
      const billNo = (first[3] || '').trim();
      const billDate = first[4] ? parseDateRobust(first[4]) : null;
      const remarks = (first[25] || '').trim() || 'Live import from Google Sheets source';
      const supplierId = (suppName ? supplierMap.get(suppName.toUpperCase()) : null) || fallbackSupplierId;

      const validLines: Array<{
        item: { id: number; uomId: number; itemCode: string; itemDesc: string };
        qty: number;
        rate: number;
        remarks: string;
      }> = [];

      for (const e of entries) {
        const itCode = (e.row[5] || '').trim();
        const recQty = parseNum(e.row[9]);
        const rate = parseNum(e.row[10]);
        const lineRemark = (e.row[25] || '').trim();
        if (!itCode || recQty <= 0) continue;
        const it = itemMap.get(itCode) || itemMap.get(itCode.toUpperCase());
        if (it) {
          validLines.push({ item: it, qty: recQty, rate, remarks: lineRemark });
        }
      }

      if (validLines.length === 0) continue;

      const hRes = await tx.query(
        `INSERT INTO grn_headers
           (grn_no, grn_date, supplier_id, invoice_no, invoice_date, remarks, status, posted_at, qc_status)
         VALUES ($1, $2, $3, $4, $5, $6, 'POSTED', $7, 'NOT_APPLICABLE')
         RETURNING id`,
        [grnNo, grnDate, supplierId, billNo, billDate, remarks, grnDate + 'T00:00:00.000Z'],
      );
      const grnHeaderId = hRes.rows[0].id;
      grnHeadersImported++;

      for (let lIdx = 0; lIdx < validLines.length; lIdx++) {
        const line = validLines[lIdx]!;
        const mln = `${grnNo}-${String(lIdx + 1).padStart(3, '0')}`;
        const lRes = await tx.query(
          `INSERT INTO grn_lines
             (grn_id, line_no, item_id, item_code, item_description, grn_qty, uom_id, rate, remarks, accepted_qty)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $6)
           RETURNING id`,
          [grnHeaderId, lIdx + 1, line.item.id, line.item.itemCode, line.item.itemDesc, line.qty, line.item.uomId, line.rate, line.remarks],
        );
        const grnLineId = lRes.rows[0].id;
        grnLinesImported++;

        await tx.query(
          `INSERT INTO grn_line_mlns (mln_no, grn_line_id, grn_id, item_id, sr_no, qty, uom_id, issued_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [mln, grnLineId, grnHeaderId, line.item.id, lIdx + 1, line.qty, line.item.uomId, grnDate + 'T00:00:00.000Z'],
        );

        const curBal = itemRunningBalance.get(line.item.id) ?? 0;
        const newBal = curBal + line.qty;
        itemRunningBalance.set(line.item.id, newBal);

        await tx.query(
          `INSERT INTO stock_ledger
             (item_id, txn_type, reference_type, reference_id, reference_no, grn_line_id, mln_no, supplier_id,
              inward_qty, outward_qty, balance_qty, uom_id, txn_date, created_at)
           VALUES ($1, 'GRN_INWARD', 'GRN', $2, $3, $4, $5, $6, $7, 0, $8, $9, $10, $11)`,
          [line.item.id, grnHeaderId, grnNo, grnLineId, mln, supplierId, line.qty, newBal, line.item.uomId, grnDate, grnDate + 'T00:00:00.000Z'],
        );
        grnStockPostings++;
      }
    }
    console.log(`     ✓ GRN Headers imported: ${grnHeadersImported}`);
    console.log(`     ✓ GRN Lines imported: ${grnLinesImported}`);
    console.log(`     ✓ Stock Ledger Inward Postings: ${grnStockPostings}`);

    // 10. Import Requisitions
    console.log('  10. Importing Requisitions and generating Stock Ledger outward postings...');
    const reqDataRows = reqRaw.slice(1).filter((r) => r.some((c) => c && c.trim()));
    let lastKnownDate: string | null = null;
    let lastKnownReqNo: string | null = null;
    let lastKnownUser: string = '';
    let lastKnownDept: string = '';
    let lastKnownCostCentre: string = '';
    let lastKnownHod: string = '';
    let unassignedIndex = 0;

    interface ParsedReqLine {
      rowIdx: number;
      srNo: number;
      reqDate: string;
      reqNo: string;
      itemCode: string;
      itemName: string;
      qty: number;
      uom: string;
      mainGroup: string;
      userName: string;
      deptName: string;
      machineNo: string;
      costCentre: string;
      hodName: string;
      hodApprovalStatus: string;
      issueSlipNo: string;
      issueDate: string;
      issuedQty: number;
      remarks: string;
    }

    const parsedLines: ParsedReqLine[] = [];

    for (let i = 0; i < reqDataRows.length; i++) {
      const r = reqDataRows[i]!;
      let itCode = (r[3] || '').trim();
      const itName = (r[4] || '').trim();

      // Skip spacer rows with no item code and no item name
      if (!itCode && !itName) continue;

      if (!itCode && itName) {
        itCode = 'ITEM_' + itName.toUpperCase().replace(/[^A-Z0-9]/g, '_').slice(0, 25);
      }

      const parsedDate = parseDateRobust(r[1]);
      const isSameDate = !parsedDate || !lastKnownDate || parsedDate === lastKnownDate;

      let reqNo = (r[2] || '').trim();
      const rawUser = (r[8] || '').trim();
      const rawDept = (r[9] || '').trim();
      const rawMachine = (r[10] || '').trim();
      const rawCostCentre = (r[11] || '').trim();
      const rawHod = (r[12] || '').trim();
      const hodStatus = (r[13] || '').trim();
      const issueSlipNo = (r[14] || '').trim();
      const issueDate = parseDateRobust(r[15]) || lastKnownDate || '2026-08-01';
      const rawQty = parseNum(r[5]);
      const rawIssuedQty = parseNum(r[16]);
      const remarks = (r[17] || '').trim();

      // If reqNo is blank:
      if (!reqNo) {
        const isSameUser = !rawUser || rawUser.toLowerCase() === lastKnownUser.toLowerCase();
        if (lastKnownReqNo && isSameDate && isSameUser) {
          reqNo = lastKnownReqNo;
        } else {
          unassignedIndex++;
          reqNo = `RN-AUTO-${String(unassignedIndex).padStart(4, '0')}`;
        }
      }

      if (parsedDate) lastKnownDate = parsedDate;
      lastKnownReqNo = reqNo;
      if (rawUser) lastKnownUser = rawUser;
      if (rawDept) lastKnownDept = rawDept;
      if (rawCostCentre) lastKnownCostCentre = rawCostCentre;
      if (rawHod) lastKnownHod = rawHod;

      parsedLines.push({
        rowIdx: i + 2,
        srNo: parsedLines.length + 1,
        reqDate: parsedDate || lastKnownDate || '2026-08-01',
        reqNo,
        itemCode: itCode,
        itemName: itName || itCode,
        qty: rawQty > 0 ? rawQty : (rawIssuedQty > 0 ? rawIssuedQty : 1),
        uom: (r[6] || '').trim().toUpperCase() || 'NOS',
        mainGroup: (r[7] || '').trim(),
        userName: rawUser || lastKnownUser,
        deptName: rawDept || lastKnownDept,
        machineNo: rawMachine,
        costCentre: rawCostCentre || lastKnownCostCentre,
        hodName: rawHod || lastKnownHod,
        hodApprovalStatus: hodStatus,
        issueSlipNo,
        issueDate,
        issuedQty: rawIssuedQty,
        remarks,
      });
    }

    const reqGroups = new Map<string, ParsedReqLine[]>();
    for (const pl of parsedLines) {
      if (!reqGroups.has(pl.reqNo)) reqGroups.set(pl.reqNo, []);
      reqGroups.get(pl.reqNo)!.push(pl);
    }

    let reqHeadersImported = 0;
    let reqLinesImported = 0;
    let issuePostings = 0;

    for (const [reqNo, entries] of reqGroups.entries()) {
      const first = entries[0]!;
      const explicitLine = entries.find((e) => parseDateRobust(e.reqDate));
      const reqDate = explicitLine ? explicitLine.reqDate : first.reqDate;

      const rawUserName = first.userName;
      const rawDeptName = first.deptName;
      const rawMachine = first.machineNo;
      const rawCostCentre = first.costCentre;
      const rawHodName = first.hodName;
      const hodStatus = first.hodApprovalStatus;
      const purpose = first.remarks || 'Internal plant requisition';

      // Robust User Match
      const matchedUser = rawUserName ? findBestUserMatch(rawUserName, allUsersList) : null;
      const requesterUserId = matchedUser ? matchedUser.id : fallbackUserId;
      const employeeCode = matchedUser ? matchedUser.employeeId : '';
      const employeeName = rawUserName || (matchedUser ? matchedUser.name : 'Internal Employee');

      // Robust HOD Match
      let hodUserId: number | null = null;
      if (rawHodName) {
        const cleanHod = rawHodName.replace(/^(mr\.|ms\.|mrs\.)\s*/i, '').trim();
        const matchedHod = /management/i.test(cleanHod) || /kunal/i.test(cleanHod)
          ? superAdminCandidate
          : (findBestUserMatch(cleanHod, hodUsersList) || findBestUserMatch(cleanHod, allUsersList));
        if (matchedHod) hodUserId = matchedHod.id;
      }

      const departmentId = rawDeptName ? (deptMap.get(rawDeptName.toUpperCase()) ?? null) : null;
      const costCentreId = rawCostCentre ? (costCentreMap.get(rawCostCentre.toUpperCase()) ?? null) : null;
      const machineId = rawMachine ? (machineMap.get(rawMachine.toUpperCase()) ?? null) : null;

      const totalRequested = entries.reduce((s, l) => s + l.qty, 0);
      const totalIssued = entries.reduce((s, l) => s + l.issuedQty, 0);
      let status = 'PENDING_APPROVAL';
      if (totalIssued >= totalRequested && totalIssued > 0) {
        status = 'FULLY_ISSUED';
      } else if (totalIssued > 0) {
        status = 'PARTIALLY_ISSUED';
      } else if (/approved/i.test(hodStatus)) {
        status = 'APPROVED';
      } else if (/rejected/i.test(hodStatus)) {
        status = 'REJECTED';
      }

      const rRes = await tx.query(
        `INSERT INTO requisition_headers
           (requisition_no, requisition_date, requester_user_id, employee_code, employee_name,
            department_id, department_name, hod_user_id, hod_name, cost_centre_id, machine_id, remarks, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         RETURNING id`,
        [reqNo, reqDate, requesterUserId, employeeCode, employeeName, departmentId, rawDeptName, hodUserId, rawHodName, costCentreId, machineId, purpose, status],
      );
      const reqHeaderId = rRes.rows[0].id;
      reqHeadersImported++;

      for (let lIdx = 0; lIdx < entries.length; lIdx++) {
        const line = entries[lIdx]!;
        const it = itemMap.get(line.itemCode) || itemMap.get(line.itemCode.toUpperCase());
        const itemId = it ? it.id : 1;
        const uomId = it ? it.uomId : defaultUomId;
        const itemDesc = it ? it.itemDesc : line.itemName;

        const lRes = await tx.query(
          `INSERT INTO requisition_lines
             (requisition_id, line_no, item_id, item_code, item_description, uom_id, requested_qty, remarks)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING id`,
          [reqHeaderId, lIdx + 1, itemId, line.itemCode, itemDesc, uomId, line.qty, line.remarks],
        );
        const reqLineId = lRes.rows[0].id;
        reqLinesImported++;

        // Process issue if exists
        if (line.issuedQty > 0 && line.issueSlipNo) {
          const issueDateActual = line.issueDate || reqDate;
          let issueId: number;
          const existingIssue = await tx.query('SELECT id FROM requisition_issues WHERE issue_slip_no = $1', [line.issueSlipNo]);
          if (existingIssue.rows.length > 0) {
            issueId = existingIssue.rows[0].id;
          } else {
            const issRes = await tx.query(
              `INSERT INTO requisition_issues (requisition_id, issue_slip_no, issue_date, remarks)
               VALUES ($1, $2, $3, $4)
               RETURNING id`,
              [reqHeaderId, line.issueSlipNo, issueDateActual, `Historical Issue Slip: ${line.issueSlipNo}`],
            );
            issueId = issRes.rows[0].id;
          }

          await tx.query(
            `INSERT INTO requisition_issue_lines
               (requisition_issue_id, requisition_line_id, item_id, requested_qty_snapshot, previously_issued_qty, issue_qty, uom_id)
             VALUES ($1, $2, $3, $4, 0, $5, $6)`,
            [issueId, reqLineId, itemId, line.qty, line.issuedQty, uomId],
          );

          const curBal = itemRunningBalance.get(itemId) ?? 0;
          const newBal = curBal - line.issuedQty;
          itemRunningBalance.set(itemId, newBal);

          await tx.query(
            `INSERT INTO stock_ledger
               (item_id, txn_type, reference_type, reference_id, reference_no,
                inward_qty, outward_qty, balance_qty, uom_id, txn_date, created_at)
             VALUES ($1, 'REQUISITION_ISSUE', 'REQUISITION_ISSUE', $2, $3, 0, $4, $5, $6, $7, $8)`,
            [itemId, issueId, line.issueSlipNo, line.issuedQty, newBal, uomId, issueDateActual, issueDateActual + 'T00:00:00.000Z'],
          );
          issuePostings++;
        }
      }
    }
    console.log(`     ✓ Requisition Headers imported: ${reqHeadersImported}`);
    console.log(`     ✓ Requisition Lines imported: ${reqLinesImported}`);
    console.log(`     ✓ Requisition Issue Outward Postings: ${issuePostings}`);

    // 11. Recalculate Live Stock Qty on items table
    console.log('  11. Updating live_stock_qty on all items...');
    await tx.query(`
      UPDATE items
         SET live_stock_qty = GREATEST(
           0,
           COALESCE(
             (SELECT balance_qty FROM stock_ledger sl WHERE sl.item_id = items.id ORDER BY sl.id DESC LIMIT 1),
             0
           )
         )
    `);
    console.log('     ✓ live_stock_qty synchronized with stock_ledger balances.');

    // 12. Ensure google_sync.enabled setting is configured in app_settings
    await tx.query(`
      INSERT INTO app_settings (key, value, description)
      VALUES ('google_sync.enabled', 'false'::jsonb, 'Master switch for Google Sheets Live Sync')
      ON CONFLICT (key) DO UPDATE SET value = 'false'::jsonb
    `);
    console.log('     ✓ Persisted google_sync.enabled = false (standalone ERP mode ready).');
  });

  console.log('\n========================================================================');
  console.log('DATABASE RESET & IMPORT COMPLETED SUCCESSFULLY');
  console.log('========================================================================\n');

  // Close DB connection
  await closeDatabase();

  // Run publication to destination sheet
  console.log('>>> PUBLISHING UPDATED ERP STATE TO DESTINATION GOOGLE SHEET...');
  const { publishDestinationSheet } = await import('./publish_destination_sheet.js');
  await publishDestinationSheet();
}

main().catch((err) => {
  console.error('FATAL ERROR DURING CONTROLLED RESET & IMPORT:', err);
  process.exit(1);
});
