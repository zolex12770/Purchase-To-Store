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
  console.log('TEST REPAIR PLAN — SIMULATION & VALIDATION');
  console.log('========================================================================\n');

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

  // Group by ReqNo with robust inherited date
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

  // Fetch all existing ERP headers
  const loginRes = await apiRequest('/auth/login', 'POST', { employeeId: '10221', password: 'Admin@123' });
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

  const erpByReqNo = new Map<string, any>();
  for (const h of erpHeaders) {
    erpByReqNo.set(h.requisition_no, h);
  }

  console.log(`Source Unique Req Groups: ${sourceGroups.size}`);
  console.log(`ERP Existing Headers: ${erpHeaders.length}`);

  // Specifically check Oct 13 requisitions
  console.log('\n--- OCTOBER 13 REQUISITIONS RECONCILIATION ---');
  const oct13InSource: string[] = [];
  for (const [reqNo, entries] of sourceGroups.entries()) {
    const explicitLine = entries.find((e) => parseDateRobust(e.row[1]));
    const trueDate = explicitLine ? parseDateRobust(explicitLine.row[1])! : entries[0]!.inheritedDate;
    if (trueDate === '2026-10-13') {
      const validLines = entries.filter((e) => {
        const it = (e.row[3] || '').trim();
        const rq = parseNum(e.row[5]);
        const iq = parseNum(e.row[16]);
        return (itemMap.has(it) || itemMap.has(it.toUpperCase())) && (rq > 0 || iq > 0);
      });
      const user = (entries[0]!.row[8] || '').trim() || (entries[0]!.row[7] || '').trim();
      const existing = erpByReqNo.get(reqNo);
      console.log(
        `ReqNo "${reqNo}": TotalLines=${entries.length}, ValidLines=${validLines.length}, User="${user}", InERP=${Boolean(existing)} (ExistingDate=${existing ? String(existing.requisition_date).slice(0, 10) : 'N/A'})`
      );
      if (validLines.length > 0) oct13InSource.push(reqNo);
    }
  }

  console.log(`\nValid Oct 13 ReqNos in Source: ${oct13InSource.length} (${oct13InSource.join(', ')})`);
}

main().catch(console.error);
