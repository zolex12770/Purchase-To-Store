import { google } from 'googleapis';
import { GoogleAuth } from 'google-auth-library';
import http from 'node:http';
import { env } from '../config/env.js';
import { scriptApiTarget, scriptCredentials } from './script-target.js';

// Target and account come from the environment; production needs ZOLEX_ALLOW_PRODUCTION=yes.
const SCRIPT_API = scriptApiTarget();
const SCRIPT_LOGIN = scriptCredentials();

const MONTH_NAMES: Record<string, string> = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

function parseDateRobust(raw: unknown): string | null {
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
        hostname: SCRIPT_API.hostname,
        port: SCRIPT_API.port,
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
  const auth = new GoogleAuth({
    keyFile: env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  const [srcRes, itemRes] = await Promise.all([
    sheets.spreadsheets.values.get({
      spreadsheetId: env.GOOGLE_SHEET_ID,
      range: "'Requisition'!A1:R",
      valueRenderOption: 'FORMATTED_VALUE',
    }),
    sheets.spreadsheets.values.get({
      spreadsheetId: env.GOOGLE_SHEET_ID,
      range: "'Item Master'!A2:C",
      valueRenderOption: 'FORMATTED_VALUE',
    }),
  ]);

  const itemMap = new Map<string, boolean>();
  for (const r of itemRes.data.values || []) {
    const c = (r[0] || '').trim();
    if (c) {
      itemMap.set(c, true);
      itemMap.set(c.toUpperCase(), true);
    }
  }

  const rows = (srcRes.data.values || []).slice(1);

  // Forward fill date tracking
  let lastKnownDate: string | null = null;
  const sourceGroups = new Map<string, Array<{ rowIdx: number; row: string[]; inheritedDate: string }>>();
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    const parsed = parseDateRobust(r[1]);
    if (parsed) lastKnownDate = parsed;

    const reqNo = (r[2] || '').trim();
    if (!reqNo) continue;
    if (!sourceGroups.has(reqNo)) sourceGroups.set(reqNo, []);
    sourceGroups.get(reqNo)!.push({ rowIdx: i + 2, row: r, inheritedDate: lastKnownDate || '1970-01-01' });
  }

  console.log(`Total Source Groups: ${sourceGroups.size}`);

  // Fetch all existing ERP headers by pagination
  const loginRes = await apiRequest('/auth/login', 'POST', SCRIPT_LOGIN);
  const token = loginRes.data.data.accessToken;

  let page = 1;
  const erpHeaders: any[] = [];
  while (true) {
    const res = await apiRequest(`/requisitions?page=${page}&pageSize=200`, 'GET', null, token);
    const pRows = res.data.data || [];
    erpHeaders.push(...pRows);
    if (page >= (res.data.meta?.totalPages || 1) || pRows.length === 0) break;
    page++;
  }
  console.log(`Fetched ${erpHeaders.length} existing ERP headers.`);

  const erpByReqNo = new Map<string, any>();
  for (const h of erpHeaders) {
    erpByReqNo.set(h.requisition_no, h);
  }

  let validGroupCount = 0;
  let quarantinedGroupCount = 0;
  let matchedGroupCount = 0;
  let missingGroupCount = 0;

  const missingGroups: Array<{ reqNo: string; date: string; validLines: number; user: string; dept: string }> = [];
  const dateMismatches: Array<{ reqNo: string; erpDate: string; srcDate: string }> = [];
  const nameMismatches: Array<{ reqNo: string; erpName: string; srcName: string }> = [];

  for (const [reqNo, entries] of sourceGroups.entries()) {
    let validLines = 0;
    for (const e of entries) {
      const itCode = (e.row[3] || '').trim();
      const reqQty = parseNum(e.row[5]);
      const issuedQty = parseNum(e.row[16]);
      const inMaster = itemMap.has(itCode) || itemMap.has(itCode.toUpperCase());
      if (inMaster && (reqQty > 0 || issuedQty > 0)) validLines++;
    }

    if (validLines === 0) {
      quarantinedGroupCount++;
      continue;
    }
    validGroupCount++;

    const explicitLine = entries.find((e) => parseDateRobust(e.row[1]));
    const trueDate = explicitLine ? parseDateRobust(explicitLine.row[1])! : entries[0]!.inheritedDate;
    const trueUser = (entries[0]!.row[8] || '').trim() || (entries[0]!.row[7] || '').trim();
    const dept = (entries[0]!.row[9] || '').trim();

    const existing = erpByReqNo.get(reqNo);
    if (existing) {
      matchedGroupCount++;
      const erpDate = String(existing.requisition_date || '').slice(0, 10);
      if (erpDate !== trueDate) {
        dateMismatches.push({ reqNo, erpDate, srcDate: trueDate });
      }
      if (existing.employee_name !== trueUser && trueUser) {
        nameMismatches.push({ reqNo, erpName: existing.employee_name, srcName: trueUser });
      }
    } else {
      missingGroupCount++;
      missingGroups.push({ reqNo, date: trueDate, validLines, user: trueUser, dept });
    }
  }

  console.log(`\n--- RECONCILIATION SUMMARY ---`);
  console.log(`Total Source Groups: ${sourceGroups.size}`);
  console.log(`Valid Source Groups (have items in master): ${validGroupCount}`);
  console.log(`Quarantined Groups (all items not in master/0 qty): ${quarantinedGroupCount}`);
  console.log(`Matched with ERP: ${matchedGroupCount}`);
  console.log(`Missing from ERP: ${missingGroupCount}`);
  console.log(`Headers with Date Mismatches: ${dateMismatches.length}`);
  console.log(`Headers with User Name Mismatches: ${nameMismatches.length}`);

  console.log('\nMissing Groups List:');
  for (const m of missingGroups) {
    console.log(`  ReqNo: "${m.reqNo}", Date: "${m.date}", Lines: ${m.validLines}, User: "${m.user}", Dept: "${m.dept}"`);
  }

  console.log('\nSample Date Mismatches (first 10):');
  for (const d of dateMismatches.slice(0, 10)) {
    console.log(`  ReqNo: "${d.reqNo}": ERP="${d.erpDate}" vs TrueSource="${d.srcDate}"`);
  }
}

main().catch(console.error);
