import { google } from 'googleapis';
import { GoogleAuth } from 'google-auth-library';
import http from 'node:http';
import { env } from '../config/env.js';
import { scriptApiTarget, scriptCredentials } from './script-target.js';

// Target and account come from the environment; production needs ZOLEX_ALLOW_PRODUCTION=yes.
const SCRIPT_API = scriptApiTarget();
const SCRIPT_LOGIN = scriptCredentials();

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

  // 1. Source Sheet
  const srcRes = await sheets.spreadsheets.values.get({
    spreadsheetId: env.GOOGLE_SHEET_ID,
    range: "'Requisition'!A1:R",
    valueRenderOption: 'FORMATTED_VALUE',
  });
  const srcRows = srcRes.data.values || [];

  const srcOct13Rows = srcRows.slice(1).map((r, i) => ({
    rowIdx: i + 2,
    date: (r[1] || '').trim(),
    reqNo: (r[2] || '').trim(),
    itemCode: (r[3] || '').trim(),
  })).filter((x) => x.date === '13-Oct-26');

  console.log(`=== 1. SOURCE SHEET (13-Oct-26) ===`);
  console.log(`Total Source rows: ${srcOct13Rows.length}`);
  const srcReqMap = new Map<string, number>();
  for (const r of srcOct13Rows) {
    srcReqMap.set(r.reqNo, (srcReqMap.get(r.reqNo) || 0) + 1);
  }
  console.log(`Distinct ReqNos in Source: ${srcReqMap.size}`);
  for (const [k, v] of srcReqMap.entries()) {
    console.log(`  Source ReqNo: "${k}" (${v} rows)`);
  }

  // 2. ERP Database
  const loginRes = await apiRequest('/auth/login', 'POST', SCRIPT_LOGIN);
  const token = loginRes.data.data.accessToken;

  const erpRes = await apiRequest('/requisitions?dateFrom=2026-10-13&dateTo=2026-10-13&pageSize=100', 'GET', null, token);
  const erpHeaders = erpRes.data.data || [];
  console.log(`\n=== 2. ERP DATABASE (2026-10-13) ===`);
  console.log(`Total ERP headers: ${erpHeaders.length}`);
  const erpReqNos = erpHeaders.map((h: any) => h.requisition_no ?? h.requisitionNo);
  console.log(`ERP ReqNos (${erpReqNos.length}):`, erpReqNos);

  // 3. Destination Sheet
  const destRes = await sheets.spreadsheets.values.get({
    spreadsheetId: env.GOOGLE_DB_SPREADSHEET_ID,
    range: "'Requisition'!A1:AH",
    valueRenderOption: 'FORMATTED_VALUE',
  });
  const destRows = destRes.data.values || [];
  const destOct13 = destRows.slice(1).filter((r) => r[3] === '2026-10-13');
  console.log(`\n=== 3. DESTINATION SPREADSHEET (2026-10-13) ===`);
  console.log(`Total Destination rows: ${destOct13.length}`);
  const destReqMap = new Map<string, number>();
  for (const r of destOct13) {
    const k = r[2] || '';
    destReqMap.set(k, (destReqMap.get(k) || 0) + 1);
  }
  console.log(`Distinct ReqNos in Destination: ${destReqMap.size}`);
  console.log('Destination ReqNos:', Array.from(destReqMap.entries()).map(([k, v]) => `"${k}": ${v} lines`));

  // 4. Comparison
  console.log(`\n=== 4. KEY COMPARISONS ===`);
  const srcSet = new Set(srcReqMap.keys());
  const erpSet = new Set(erpReqNos);
  const destSet = new Set(destReqMap.keys());

  console.log('A. Source ReqNos matching ERP ReqNos:');
  const matched = Array.from(srcSet).filter((k) => erpSet.has(k));
  console.log(`   Count: ${matched.length}:`, matched);

  console.log('B. Source ReqNos NOT in ERP 2026-10-13:');
  const inSrcNotErp = Array.from(srcSet).filter((k) => !erpSet.has(k));
  console.log(`   Count: ${inSrcNotErp.length}:`, inSrcNotErp);

  // For any in Source not in ERP on 2026-10-13, what date are they in ERP?
  console.log('\nChecking where those Source ReqNos went in ERP:');
  for (const reqNo of inSrcNotErp) {
    if (!reqNo) continue;
    const findRes = await apiRequest(`/requisitions?search=${encodeURIComponent(reqNo)}`, 'GET', null, token);
    const found = findRes.data.data || [];
    if (found.length > 0) {
      console.log(`   Source ReqNo "${reqNo}" exists in ERP with requisition_date = "${found[0].requisition_date ?? found[0].requisitionDate}"!`);
    } else {
      console.log(`   Source ReqNo "${reqNo}" NOT FOUND anywhere in ERP!`);
    }
  }

  console.log('\nC. ERP ReqNos NOT in Source 13-Oct:');
  const inErpNotSrc = Array.from(erpSet).filter((k) => !srcSet.has(k));
  console.log(`   Count: ${inErpNotSrc.length}:`, inErpNotSrc);

  // For each extra ERP ReqNo, find its occurrence in the Source Sheet!
  console.log('\nFinding where each extra ERP ReqNo appears in Source Sheet:');
  for (const extra of inErpNotSrc) {
    const srcOccurrences = srcRows.slice(1).map((r, i) => ({ rowIdx: i + 2, date: r[1], reqNo: r[2] })).filter((x) => x.reqNo === extra);
    if (srcOccurrences.length > 0) {
      console.log(`   ERP "${extra}" was in Source on date "${srcOccurrences[0].date}" (rows: ${srcOccurrences.map((o) => o.rowIdx).join(', ')})`);
    } else {
      console.log(`   ERP "${extra}" does NOT exist in Source sheet!`);
    }
  }
}

main().catch(console.error);
