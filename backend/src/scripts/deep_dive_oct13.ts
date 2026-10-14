import { google } from 'googleapis';
import { GoogleAuth } from 'google-auth-library';
import http from 'node:http';
import { env } from '../config/env.js';

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
  console.log('DEEP-DIVE AUDIT: 13 OCTOBER REQUISITION DISCREPANCY (36 vs 51 vs 215)');
  console.log('========================================================================\n');

  const auth = new GoogleAuth({
    keyFile: env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  // 1. Fetch Source Sheet rows
  const srcRes = await sheets.spreadsheets.values.get({
    spreadsheetId: env.GOOGLE_SHEET_ID,
    range: "'Requisition'!A1:R",
    valueRenderOption: 'FORMATTED_VALUE',
  });
  const srcRawRes = await sheets.spreadsheets.values.get({
    spreadsheetId: env.GOOGLE_SHEET_ID,
    range: "'Requisition'!A1:R",
    valueRenderOption: 'UNFORMATTED_VALUE',
  });

  const srcRows = srcRes.data.values || [];
  const srcRawRows = srcRawRes.data.values || [];

  const srcOct13Rows: Array<{
    rowIdx: number;
    formattedDate: string;
    rawDate: any;
    reqNo: string;
    itemCode: string;
    itemName: string;
    reqQty: string;
    empName: string;
    dept: string;
    status: string;
  }> = [];

  for (let i = 1; i < srcRows.length; i++) {
    const r = srcRows[i];
    const rawR = srcRawRows[i] || [];
    const d = (r[1] || '').trim();
    if (d === '13-Oct-26') {
      srcOct13Rows.push({
        rowIdx: i + 1,
        formattedDate: d,
        rawDate: rawR[1],
        reqNo: (r[2] || '').trim(),
        itemCode: (r[3] || '').trim(),
        itemName: (r[4] || '').trim(),
        reqQty: (r[5] || '').trim(),
        empName: (r[7] || '').trim(),
        dept: (r[9] || '').trim(),
        status: (r[13] || '').trim(),
      });
    }
  }

  console.log(`Source rows with Date = '13-Oct-26': ${srcOct13Rows.length}`);
  const srcReqMap = new Map<string, typeof srcOct13Rows>();
  for (const r of srcOct13Rows) {
    if (!srcReqMap.has(r.reqNo)) srcReqMap.set(r.reqNo, []);
    srcReqMap.get(r.reqNo)!.push(r);
  }
  console.log(`Distinct ReqNos in Source for '13-Oct-26': ${srcReqMap.size}`);
  console.log('Breakdown by ReqNo in Source:');
  for (const [k, v] of srcReqMap.entries()) {
    console.log(`  ReqNo: "${k}" -> ${v.length} lines (Rows: ${v.map((x) => x.rowIdx).join(', ')})`);
  }

  // Also check ALL rows in source with these ReqNos! Do these ReqNos appear on other dates?
  const allReqNos = Array.from(srcReqMap.keys());
  for (const reqNo of allReqNos) {
    const allOccurrences = srcRows.slice(1).map((r, i) => ({ rowIdx: i + 2, date: r[1], reqNo: r[2] })).filter((x) => x.reqNo === reqNo);
    if (allOccurrences.length !== srcReqMap.get(reqNo)!.length) {
      console.log(`  WARNING: ReqNo "${reqNo}" has ${allOccurrences.length} total occurrences across all dates in source! Dates:`, allOccurrences.map((o) => `${o.date} (row ${o.rowIdx})`));
    }
  }

  // 2. Fetch ERP Requisition Headers for 2026-10-13
  const loginRes = await apiRequest('/auth/login', 'POST', { employeeId: '10221', password: 'Admin@123' });
  const token = loginRes.data.data.accessToken;

  const erpRes = await apiRequest('/requisitions?dateFrom=2026-10-13&dateTo=2026-10-13&pageSize=100', 'GET', null, token);
  const erpHeaders = erpRes.data.data || [];
  console.log(`\nERP Headers returned for 2026-10-13: ${erpHeaders.length}`);

  const erpReqMap = new Map<string, any>();
  for (const h of erpHeaders) {
    erpReqMap.set(h.requisitionNo, h);
  }

  // 3. Fetch Destination Rows for 2026-10-13
  const destRes = await sheets.spreadsheets.values.get({
    spreadsheetId: env.GOOGLE_DB_SPREADSHEET_ID,
    range: "'Requisition'!A1:AH",
    valueRenderOption: 'FORMATTED_VALUE',
  });
  const destRows = destRes.data.values || [];
  const destOct13 = destRows.slice(1).filter((r) => r[3] === '2026-10-13');
  console.log(`\nDestination Sheet lines for 2026-10-13: ${destOct13.length}`);

  const destReqMap = new Map<string, number>();
  for (const r of destOct13) {
    const reqNo = r[2] || '';
    destReqMap.set(reqNo, (destReqMap.get(reqNo) || 0) + 1);
  }
  console.log(`Distinct ReqNos in Destination Sheet: ${destReqMap.size}`);

  // 4. Compare ReqNos between Source (36 rows, X distinct) and ERP (51 headers)
  console.log('\n--- CROSS-COMPARISON OF REQUISITION NUMBERS ---');
  const srcKeys = new Set(srcReqMap.keys());
  const erpKeys = new Set(erpReqMap.keys());
  const destKeys = new Set(destReqMap.keys());

  console.log('1. In Source AND In ERP:');
  const inBoth = Array.from(srcKeys).filter((k) => erpKeys.has(k));
  console.log(`   Count: ${inBoth.length}:`, inBoth);

  console.log('2. In Source BUT MISSING in ERP:');
  const inSrcNotErp = Array.from(srcKeys).filter((k) => !erpKeys.has(k));
  console.log(`   Count: ${inSrcNotErp.length}:`, inSrcNotErp);

  console.log('3. In ERP BUT NOT in Source 13-Oct:');
  const inErpNotSrc = Array.from(erpKeys).filter((k) => !srcKeys.has(k));
  console.log(`   Count: ${inErpNotSrc.length}:`, inErpNotSrc);

  // For the ones in ERP but NOT in Source 13-Oct, where did they come from in Source?
  console.log('\nTracing the extra ERP headers in the Source Sheet:');
  for (const extraReqNo of inErpNotSrc) {
    const srcMatches = srcRows.slice(1).map((r, i) => ({ rowIdx: i + 2, date: r[1], reqNo: r[2], itemCode: r[3] })).filter((x) => x.reqNo === extraReqNo);
    if (srcMatches.length > 0) {
      console.log(`   ERP ReqNo "${extraReqNo}" exists in Source on Date: "${srcMatches[0].date}" (Rows: ${srcMatches.map((m) => m.rowIdx).join(', ')})`);
    } else {
      console.log(`   ERP ReqNo "${extraReqNo}" DOES NOT EXIST in Source at all (Native ERP created?)`);
    }
  }
}

main().catch(console.error);
