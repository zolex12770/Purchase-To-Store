import { google } from 'googleapis';
import { GoogleAuth } from 'google-auth-library';
import { env } from '../config/env.js';
import { getDatabase, closeDatabase } from '../db/index.js';

const MONTH_NAMES: Record<string, string> = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

export function parseDateRobust(raw: unknown): string | null {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;

  const dMonMatch = s.match(/^(\d{1,2})[-/ ]([A-Za-z]{3})[-/ ](\d{2,4})$/);
  if (dMonMatch) {
    const day = dMonMatch[1]!.padStart(2, '0');
    const monStr = dMonMatch[2]!.toLowerCase();
    const month = MONTH_NAMES[monStr];
    let year = dMonMatch[3]!;
    if (year.length === 2) year = '20' + year;
    if (month) return `${year}-${month}-${day}`;
  }

  if (/^\d{5}$/.test(s)) {
    const serial = parseInt(s, 10);
    const utcDays = serial - 25569;
    const date = new Date(utcDays * 86400 * 1000);
    return date.toISOString().slice(0, 10);
  }

  const dmyMatch = s.match(/^(\d{1,2})[\/\.-](\d{1,2})[\/\.-](\d{2,4})$/);
  if (dmyMatch) {
    const day = dmyMatch[1]!.padStart(2, '0');
    const month = dmyMatch[2]!.padStart(2, '0');
    let year = dmyMatch[3]!;
    if (year.length === 2) year = '20' + year;
    return `${year}-${month}-${day}`;
  }

  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    return s.slice(0, 10);
  }

  return null;
}

export function parseNum(raw: unknown): number {
  if (raw === null || raw === undefined) return 0;
  const s = String(raw).replace(/,/g, '').trim();
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

async function main() {
  const isExecute = process.argv.includes('--execute');
  console.log('========================================================================');
  console.log(`CLEAN REQUISITION RE-IMPORT & SYNC — MODE: ${isExecute ? 'LIVE EXECUTE' : 'DRY-RUN'}`);
  console.log('Timestamp:', new Date().toISOString());
  console.log('========================================================================\n');

  const auth = new GoogleAuth({
    keyFile: env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  console.log('1. Fetching live Source Requisition tab & Item Master...');
  const [srcRes, itemRes] = await Promise.all([
    sheets.spreadsheets.values.get({
      spreadsheetId: env.GOOGLE_SHEET_ID,
      range: "'Requisition'!A1:ZZ",
      valueRenderOption: 'FORMATTED_VALUE',
    }),
    sheets.spreadsheets.values.get({
      spreadsheetId: env.GOOGLE_SHEET_ID,
      range: "'Item Master'!A2:C",
      valueRenderOption: 'FORMATTED_VALUE',
    }),
  ]);

  const rawRows = (srcRes.data.values || []).slice(1);
  const dataRows = rawRows.filter((r) => r.some((c) => c && String(c).trim()));
  console.log(`  Source physical data rows: ${dataRows.length}`);

  // Forward filling dates
  let lastKnownDate: string | null = null;
  const reqGroups = new Map<string, Array<{ rowIdx: number; row: string[]; inheritedDate: string }>>();
  let skippedNoReqNo = 0;

  for (let i = 0; i < dataRows.length; i++) {
    const r = dataRows[i]!;
    const parsed = parseDateRobust(r[1]);
    if (parsed) lastKnownDate = parsed;

    const reqNo = (r[2] || '').trim();
    if (!reqNo) {
      skippedNoReqNo++;
      continue;
    }
    if (!reqGroups.has(reqNo)) reqGroups.set(reqNo, []);
    reqGroups.get(reqNo)!.push({ rowIdx: i + 2, row: r, inheritedDate: lastKnownDate || '1970-01-01' });
  }

  console.log(`  Skipped rows with missing ReqNo: ${skippedNoReqNo}`);
  console.log(`  Total distinct Requisition groups: ${reqGroups.size}`);

  if (!isExecute) {
    console.log('\n[DRY RUN ONLY] Pass --execute to apply changes to the database.');
    return;
  }

  // LIVE EXECUTION
  console.log('\n2. Connecting to Database...');
  const db = await getDatabase();

  console.log('3. Loading Lookups & Items from Database...');
  const [itemsRes, usersRes, deptsRes, costCentresRes] = await Promise.all([
    db.query(`SELECT id, upper(item_code) as code, item_code as raw_code, item_description, uom_id FROM items`),
    db.query(`SELECT id, upper(employee_name) as norm_name, employee_name, employee_id FROM users WHERE deleted_at IS NULL`),
    db.query(`SELECT id, upper(name) as norm_name, name FROM lookups WHERE category = 'DEPARTMENT' AND deleted_at IS NULL`),
    db.query(`SELECT id, upper(name) as norm_name, name FROM lookups WHERE category = 'COST_CENTRE' AND deleted_at IS NULL`),
  ]);

  const itemDbMap = new Map<string, { id: number; uomId: number; itemCode: string; itemDesc: string }>();
  for (const r of itemsRes.rows as any[]) {
    itemDbMap.set(r.code, { id: r.id, uomId: r.uom_id, itemCode: r.raw_code, itemDesc: r.item_description });
  }

  const userMap = new Map<string, { id: number; name: string; empCode: string }>();
  for (const r of usersRes.rows as any[]) {
    userMap.set(r.norm_name, { id: r.id, name: r.employee_name, empCode: r.employee_id || '' });
  }

  const deptMap = new Map<string, number>();
  for (const r of deptsRes.rows as any[]) {
    deptMap.set(r.norm_name, r.id);
  }

  const costCentreMap = new Map<string, number>();
  for (const r of costCentresRes.rows as any[]) {
    costCentreMap.set(r.norm_name, r.id);
  }

  const fallbackUser = usersRes.rows.find((u: any) => u.employee_name === 'Kunal Raju Dulani') || usersRes.rows[0];
  const fallbackUserId = (fallbackUser as any)?.id ?? 1;

  console.log(`  Items cached: ${itemDbMap.size}`);
  console.log(`  Users cached: ${userMap.size}`);
  console.log(`  Departments cached: ${deptMap.size}`);
  console.log(`  Cost Centres cached: ${costCentreMap.size}`);

  console.log('\n4. Executing Database Update in Transaction...');
  await db.transaction(async (tx) => {
    // 4a. Clear existing requisition records
    console.log('  Clearing legacy requisition tables...');
    await tx.query('DELETE FROM requisition_issue_lines');
    await tx.query('DELETE FROM requisition_issues');
    await tx.query('DELETE FROM requisition_approvals');
    await tx.query('DELETE FROM requisition_lines');
    await tx.query('DELETE FROM requisition_headers');
    await tx.query("DELETE FROM stock_ledger WHERE reference_type = 'REQUISITION_ISSUE'");

    let reqHeadersImported = 0;
    let reqLinesImported = 0;
    let reqLinesQuarantined = 0;
    let issuePostings = 0;
    const oct13Inserted: string[] = [];

    // Get current stock running balance per item from existing ledger
    const balanceRes = await tx.query(`
      SELECT item_id, COALESCE(SUM(inward_qty - outward_qty), 0)::numeric(18, 4) as balance
        FROM stock_ledger
       GROUP BY item_id
    `);
    const itemRunningBalance = new Map<number, number>();
    for (const r of balanceRes.rows as any[]) {
      itemRunningBalance.set(Number(r.item_id), Number(r.balance));
    }

    // 4b. Insert Requisitions
    for (const [reqNo, entries] of reqGroups.entries()) {
      const explicitLine = entries.find((e) => parseDateRobust(e.row[1]));
      const reqDate = explicitLine ? parseDateRobust(explicitLine.row[1])! : entries[0]!.inheritedDate;

      // Real User Name from Column 8
      const rawUserName = (entries[0]!.row[8] || '').trim();
      const rawDeptName = (entries[0]!.row[9] || '').trim();
      const rawCostCentre = (entries[0]!.row[11] || '').trim();
      const hodStatus = (entries[0]!.row[13] || '').trim();
      const purpose = (entries[0]!.row[17] || '').trim() || 'Internal plant requisition';

      const matchedUser = rawUserName ? userMap.get(rawUserName.toUpperCase()) : null;
      const requesterUserId = matchedUser ? matchedUser.id : fallbackUserId;
      const employeeCode = matchedUser ? matchedUser.empCode : '';
      const employeeName = rawUserName || (entries[0]!.row[7] || '').trim() || 'Internal User';

      const departmentId = rawDeptName ? (deptMap.get(rawDeptName.toUpperCase()) ?? null) : null;
      const costCentreId = rawCostCentre ? (costCentreMap.get(rawCostCentre.toUpperCase()) ?? null) : null;
      const status = /approved/i.test(hodStatus) ? 'APPROVED' : (/rejected/i.test(hodStatus) ? 'REJECTED' : 'PENDING_APPROVAL');

      // Filter valid lines
      const validLines: Array<{
        item: { id: number; uomId: number; itemCode: string; itemDesc: string };
        qty: number;
        issueSlipNo: string;
        issueDate: string;
        issuedQty: number;
        remarks: string;
        rowIdx: number;
      }> = [];

      for (const e of entries) {
        const itCode = (e.row[3] || '').trim();
        const reqQty = parseNum(e.row[5]);
        const issueSlipNo = (e.row[14] || '').trim();
        const issueDate = parseDateRobust(e.row[15]) || reqDate;
        const issuedQty = parseNum(e.row[16]);
        const remarks = (e.row[17] || '').trim();

        if (!itCode) {
          reqLinesQuarantined++;
          continue;
        }

        const it = itemDbMap.get(itCode.toUpperCase());
        if (!it) {
          reqLinesQuarantined++;
          continue;
        }

        if (reqQty > 0 || issuedQty > 0) {
          validLines.push({
            item: it,
            qty: reqQty > 0 ? reqQty : issuedQty,
            issueSlipNo,
            issueDate,
            issuedQty,
            remarks,
            rowIdx: e.rowIdx,
          });
        }
      }

      if (validLines.length === 0) continue; // quarantined group

      // Insert Header
      const hRes = await tx.query(
        `INSERT INTO requisition_headers
           (requisition_no, requisition_date, requester_user_id, employee_code, employee_name, department_id, department_name, cost_centre_id, remarks, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING id`,
        [reqNo, reqDate, requesterUserId, employeeCode, employeeName, departmentId, rawDeptName, costCentreId, purpose, status],
      );
      const reqHeaderId = (hRes.rows[0] as any).id;
      reqHeadersImported++;

      if (reqDate === '2026-10-13') {
        oct13Inserted.push(reqNo);
      }

      // Insert Lines
      for (let lIdx = 0; lIdx < validLines.length; lIdx++) {
        const line = validLines[lIdx]!;
        const lRes = await tx.query(
          `INSERT INTO requisition_lines
             (requisition_id, line_no, item_id, item_code, item_description, uom_id, requested_qty, remarks)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING id`,
          [reqHeaderId, lIdx + 1, line.item.id, line.item.itemCode, line.item.itemDesc, line.item.uomId, line.qty, line.remarks],
        );
        const reqLineId = (lRes.rows[0] as any).id;
        reqLinesImported++;

        // If issue slip exists, create issue record and deduct stock ledger
        if (line.issuedQty > 0 && line.issueSlipNo) {
          const issueDateActual = line.issueDate || reqDate;
          let issueId: number;

          const existingIssue = await tx.query(
            `SELECT id FROM requisition_issues WHERE issue_slip_no = $1`,
            [line.issueSlipNo],
          );
          if (existingIssue.rows.length > 0) {
            issueId = (existingIssue.rows[0] as any).id;
          } else {
            const issRes = await tx.query(
              `INSERT INTO requisition_issues
                 (requisition_id, issue_slip_no, issue_date, remarks)
               VALUES ($1, $2, $3, $4)
               RETURNING id`,
              [reqHeaderId, line.issueSlipNo, issueDateActual, `Historical Issue Slip: ${line.issueSlipNo}`],
            );
            issueId = (issRes.rows[0] as any).id;
          }

          await tx.query(
            `INSERT INTO requisition_issue_lines
               (requisition_issue_id, requisition_line_id, item_id, requested_qty_snapshot, previously_issued_qty, issue_qty, uom_id, remarks)
             VALUES ($1, $2, $3, $4, 0, $5, $6, $7)`,
            [issueId, reqLineId, line.item.id, line.qty, line.issuedQty, line.item.uomId, line.remarks],
          );

          // Deduct from running balance
          const currentBal = itemRunningBalance.get(line.item.id) ?? 0;
          const newBal = currentBal - line.issuedQty;
          itemRunningBalance.set(line.item.id, newBal);

          // Post stock ledger issue
          await tx.query(
            `INSERT INTO stock_ledger
               (item_id, txn_type, reference_type, reference_id, reference_no, inward_qty, outward_qty, balance_qty, uom_id, txn_date, created_at)
             VALUES ($1, 'REQUISITION_ISSUE', 'REQUISITION_ISSUE', $2, $3, 0, $4, $5, $6, $7, $8)`,
            [
              line.item.id, issueId, line.issueSlipNo, line.issuedQty,
              newBal, line.item.uomId, issueDateActual, issueDateActual + 'T00:00:00.000Z',
            ],
          );
          issuePostings++;
        }
      }
    }

    // 4c. Update items live stock quantities
    console.log('  Reconciling live stock quantities on items table...');
    for (const [itemId, finalBal] of itemRunningBalance.entries()) {
      await tx.query(`UPDATE items SET live_stock_qty = $1 WHERE id = $2`, [Math.max(0, finalBal), itemId]);
    }

    console.log('\n--- EXECUTION RESULTS ---');
    console.log(`  ✓ Requisition Headers Imported: ${reqHeadersImported}`);
    console.log(`  ✓ Requisition Lines Imported: ${reqLinesImported}`);
    console.log(`  ✓ Requisition Lines Quarantined: ${reqLinesQuarantined}`);
    console.log(`  ✓ Stock Ledger Issue Postings: ${issuePostings}`);
    console.log(`  ✓ October 13 Headers (${oct13Inserted.length}): ${oct13Inserted.join(', ')}`);
  });

  await closeDatabase();
  console.log('\n========================================================================');
  console.log('CLEAN RE-IMPORT COMPLETED SUCCESSFULLY IN TRANSACTION!');
  console.log('========================================================================');
}

main().catch(async (err) => {
  console.error('FATAL RE-IMPORT ERROR:', err);
  try { await closeDatabase(); } catch {}
  process.exit(1);
});
