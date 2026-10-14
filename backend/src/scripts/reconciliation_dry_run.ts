import { google } from 'googleapis';
import { GoogleAuth } from 'google-auth-library';
import http from 'node:http';
import { env } from '../config/env.js';

const MONTH_NAMES: Record<string, string> = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

function parseDateRobust(raw: unknown): string | null {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;

  // 1. DD-Mon-YY or DD-Mon-YYYY (e.g. 13-Oct-26, 01-Aug-26, 25-Sep-2026)
  const dMonMatch = s.match(/^(\d{1,2})[-/ ]([A-Za-z]{3})[-/ ](\d{2,4})$/);
  if (dMonMatch) {
    const day = dMonMatch[1]!.padStart(2, '0');
    const monStr = dMonMatch[2]!.toLowerCase();
    const month = MONTH_NAMES[monStr];
    let year = dMonMatch[3]!;
    if (year.length === 2) year = '20' + year;
    if (month) return `${year}-${month}-${day}`;
  }

  // 2. Excel serial number (e.g. 46308)
  if (/^\d{5}$/.test(s)) {
    const serial = parseInt(s, 10);
    const utcDays = serial - 25569;
    const date = new Date(utcDays * 86400 * 1000);
    return date.toISOString().slice(0, 10);
  }

  // 3. DD/MM/YYYY or DD-MM-YYYY
  const dmyMatch = s.match(/^(\d{1,2})[\/\.-](\d{1,2})[\/\.-](\d{2,4})$/);
  if (dmyMatch) {
    const day = dmyMatch[1]!.padStart(2, '0');
    const month = dmyMatch[2]!.padStart(2, '0');
    let year = dmyMatch[3]!;
    if (year.length === 2) year = '20' + year;
    return `${year}-${month}-${day}`;
  }

  // 4. YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    return s.slice(0, 10);
  }

  return null;
}

function parseNum(raw: unknown): number {
  if (raw === null || raw === undefined) return 0;
  const s = String(raw).replace(/,/g, '').trim();
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

function apiRequest<T = any>(
  endpoint: string,
  method = 'GET',
  body?: any,
  token?: string,
): Promise<{ status: number; data: any }> {
  return new Promise((resolve, reject) => {
    const dataStr = body ? JSON.stringify(body) : undefined;
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: 4001,
        path: `/api/v1${endpoint}`,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(dataStr ? { 'Content-Length': Buffer.byteLength(dataStr) } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode || 200, data: JSON.parse(raw) });
          } catch {
            resolve({ status: res.statusCode || 200, data: raw });
          }
        });
      },
    );
    req.on('error', reject);
    if (dataStr) req.write(dataStr);
    req.end();
  });
}

async function main() {
  console.log('========================================================================');
  console.log('RECONCILIATION DRY-RUN & IMPACT ANALYSIS');
  console.log('Timestamp:', new Date().toISOString());
  console.log('========================================================================\n');

  const auth = new GoogleAuth({
    keyFile: env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  // 1. Load Source Requisition rows
  const srcRes = await sheets.spreadsheets.values.get({
    spreadsheetId: env.GOOGLE_SHEET_ID,
    range: "'Requisition'!A1:R",
    valueRenderOption: 'FORMATTED_VALUE',
  });
  const rows = (srcRes.data.values || []).slice(1);

  // 2. Load Item Master codes
  const itemRes = await sheets.spreadsheets.values.get({
    spreadsheetId: env.GOOGLE_SHEET_ID,
    range: "'Item Master'!A2:C",
    valueRenderOption: 'FORMATTED_VALUE',
  });
  const itemMap = new Map<string, boolean>();
  for (const r of itemRes.data.values || []) {
    const c = (r[0] || '').trim();
    if (c) {
      itemMap.set(c, true);
      itemMap.set(c.toUpperCase(), true);
    }
  }

  // 3. Authenticate to ERP API
  const loginRes = await apiRequest('/auth/login', 'POST', { employeeId: '10221', password: 'Admin@123' });
  const token = loginRes.data.data.accessToken;

  // 4. Fetch all ERP Requisition Headers
  const erpRes = await apiRequest('/requisitions?pageSize=2000', 'GET', null, token);
  const erpHeaders = erpRes.data.data || [];
  const erpHeaderByReqNo = new Map<string, any>();
  for (const h of erpHeaders) {
    erpHeaderByReqNo.set(h.requisition_no ?? h.requisitionNo, h);
  }
  console.log(`Current ERP Requisition Headers: ${erpHeaders.length}`);

  // 5. Compute true source dates with forward-filling
  let lastKnownDate: string | null = null;
  const resolvedRows: Array<{
    rowIdx: number;
    srNo: string;
    rawDate: string;
    trueDate: string;
    reqNo: string;
    itemCode: string;
    itemName: string;
    qty: number;
    uom: string;
    mainGroup: string;
    userName: string;
    dept: string;
    costCentre: string;
    hodStatus: string;
    issueSlip: string;
    issueDate: string;
    issuedQty: number;
    remarks: string;
    isValidLine: boolean;
  }> = [];

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    const rawDate = (r[1] || '').trim();
    const parsed = parseDateRobust(rawDate);
    if (parsed) lastKnownDate = parsed;

    const reqNo = (r[2] || '').trim();
    const itCode = (r[3] || '').trim();
    const reqQty = parseNum(r[5]);
    const issuedQty = parseNum(r[16]);
    const inMaster = Boolean(itCode && (itemMap.has(itCode) || itemMap.has(itCode.toUpperCase())));
    const isValid = Boolean(reqNo && itCode && inMaster && (reqQty > 0 || issuedQty > 0));

    resolvedRows.push({
      rowIdx: i + 2,
      srNo: (r[0] || '').trim(),
      rawDate,
      trueDate: lastKnownDate || '1970-01-01',
      reqNo,
      itemCode: itCode,
      itemName: (r[4] || '').trim(),
      qty: reqQty,
      uom: (r[6] || '').trim(),
      mainGroup: (r[7] || '').trim(),
      userName: (r[8] || '').trim(),
      dept: (r[9] || '').trim(),
      costCentre: (r[11] || '').trim(),
      hodStatus: (r[13] || '').trim(),
      issueSlip: (r[14] || '').trim(),
      issueDate: parseDateRobust(r[15]) || '',
      issuedQty,
      remarks: (r[17] || '').trim(),
      isValidLine: isValid,
    });
  }

  // Group by ReqNo
  const sourceGroups = new Map<string, typeof resolvedRows>();
  for (const r of resolvedRows) {
    if (!r.reqNo) continue;
    if (!sourceGroups.has(r.reqNo)) sourceGroups.set(r.reqNo, []);
    sourceGroups.get(r.reqNo)!.push(r);
  }

  console.log(`Total Source ReqGroups: ${sourceGroups.size}`);

  // Calculate changes needed in ERP Database
  const dateUpdates: Array<{ id: number; reqNo: string; oldDate: string; newDate: string }> = [];
  const nameUpdates: Array<{ id: number; reqNo: string; oldName: string; newName: string }> = [];
  const newHeadersToInsert: Array<{ reqNo: string; date: string; validLines: number; userName: string; dept: string }> = [];

  for (const [reqNo, entries] of sourceGroups.entries()) {
    const validLines = entries.filter((e) => e.isValidLine);
    if (validLines.length === 0) continue; // skipped group (no valid items in master)

    // True header date: prefer explicit line date if any, else inherited
    const explicitLine = entries.find((e) => parseDateRobust(e.rawDate));
    const trueHeaderDate = explicitLine ? parseDateRobust(explicitLine.rawDate)! : entries[0]!.trueDate;
    const trueUserName = entries[0]!.userName || entries[0]!.mainGroup;

    const existingHeader = erpHeaderByReqNo.get(reqNo);
    if (existingHeader) {
      const existingDate = String(existingHeader.requisition_date || '').slice(0, 10);
      if (existingDate !== trueHeaderDate) {
        dateUpdates.push({
          id: existingHeader.id,
          reqNo,
          oldDate: existingDate,
          newDate: trueHeaderDate,
        });
      }
      if (existingHeader.employee_name !== trueUserName && trueUserName) {
        nameUpdates.push({
          id: existingHeader.id,
          reqNo,
          oldName: existingHeader.employee_name,
          newName: trueUserName,
        });
      }
    } else {
      newHeadersToInsert.push({
        reqNo,
        date: trueHeaderDate,
        validLines: validLines.length,
        userName: trueUserName,
        dept: entries[0]!.dept,
      });
    }
  }

  console.log('\n--- DRY RUN RESULTS ---');
  console.log(`1. Requisition Headers needing Date Correction: ${dateUpdates.length}`);
  console.log('   Sample Date Updates (first 10):');
  for (const u of dateUpdates.slice(0, 10)) {
    console.log(`     ID ${u.id} (${u.reqNo}): "${u.oldDate}" -> "${u.newDate}"`);
  }

  console.log(`\n2. Requisition Headers needing User Name Correction (Main Group -> Real User): ${nameUpdates.length}`);
  console.log('   Sample Name Updates (first 5):');
  for (const u of nameUpdates.slice(0, 5)) {
    console.log(`     ID ${u.id} (${u.reqNo}): "${u.oldName}" -> "${u.newName}"`);
  }

  console.log(`\n3. Missing Requisition Headers to Insert: ${newHeadersToInsert.length}`);
  for (const n of newHeadersToInsert) {
    console.log(`     ReqNo: "${n.reqNo}", Date: "${n.date}", Valid Lines: ${n.validLines}, User: "${n.userName}", Dept: "${n.dept}"`);
  }

  // Check 13-Oct-26 specifically before and after
  console.log('\n========================================================================');
  console.log('13 OCTOBER 2026 BEFORE VS AFTER PROJECTION');
  console.log('========================================================================');
  const currentOct13InErp = erpHeaders.filter((h: any) => String(h.requisition_date || '').slice(0, 10) === '2026-10-13');
  console.log(`Current ERP Headers on 2026-10-13: ${currentOct13InErp.length} (Wrongly included 51 blank-date historical requisitions)`);

  const afterOct13Headers = [
    ...erpHeaders.filter((h: any) => {
      const u = dateUpdates.find((x) => x.id === h.id);
      const effDate = u ? u.newDate : String(h.requisition_date || '').slice(0, 10);
      return effDate === '2026-10-13';
    }),
    ...newHeadersToInsert.filter((n) => n.date === '2026-10-13'),
  ];

  console.log(`Projected ERP Headers on 2026-10-13 After Correction: ${afterOct13Headers.length}`);
  console.log('Projected 2026-10-13 ReqNos:');
  for (const h of afterOct13Headers) {
    console.log(`  ${h.reqNo ?? h.requisition_no} (User: ${h.userName ?? h.employee_name})`);
  }
}

main().catch(console.error);
