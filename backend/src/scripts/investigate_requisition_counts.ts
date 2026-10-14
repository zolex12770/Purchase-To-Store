import http from 'node:http';
import { google } from 'googleapis';
import { GoogleAuth } from 'google-auth-library';
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
  console.log('INVESTIGATING REQUISITION DATA ACCURACY & DATE COUNTS');
  console.log('Timestamp:', new Date().toISOString());
  console.log('Source Sheet:', env.GOOGLE_SHEET_ID);
  console.log('Destination Sheet:', env.GOOGLE_DB_SPREADSHEET_ID);
  console.log('========================================================================\n');

  const auth = new GoogleAuth({
    keyFile: env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  // 1. Authenticate to ERP API
  const loginRes = await apiRequest('/auth/login', 'POST', {
    employeeId: '10221',
    password: 'Admin@123',
  });
  const token = loginRes.data.data.accessToken;

  // ---------------------------------------------------------------------------
  // A. INSPECT ORIGINAL SOURCE SPREADSHEET
  // ---------------------------------------------------------------------------
  console.log('--- A. ORIGINAL SOURCE SPREADSHEET ---');
  const srcRes = await sheets.spreadsheets.values.get({
    spreadsheetId: env.GOOGLE_SHEET_ID,
    range: "'Requisition'!A1:R",
    valueRenderOption: 'FORMATTED_VALUE',
  });
  const srcRows = srcRes.data.values ?? [];
  const srcHeaders = srcRows[0] ?? [];
  console.log('Source Headers:', srcHeaders);

  const srcData = srcRows.slice(1).map((r, i) => ({
    rowNum: i + 2,
    rawDate: r[1] ?? '',
    reqNo: (r[2] ?? '').trim(),
    itemCode: (r[3] ?? '').trim(),
    reqQty: r[5] ?? '',
    empCode: r[6] ?? '',
    empName: r[7] ?? '',
    dept: r[9] ?? '',
    status: r[13] ?? '',
    issueSlip: r[14] ?? '',
    rawValues: r,
  }));

  // Analyze all date formats and values in source
  const srcDateCounts: Record<string, number> = {};
  for (const r of srcData) {
    srcDateCounts[r.rawDate] = (srcDateCounts[r.rawDate] ?? 0) + 1;
  }
  console.log('Top dates in source sheet:', Object.entries(srcDateCounts).slice(0, 15));

  // Check specific dates: 13-10-2026, 13/10/2026, 13-10-2036, 13/10/2036, 2026-10-13, 2036-10-13
  const targetDates = ['13-10-2026', '13/10/2026', '13-10-2036', '13/10/2036', '2026-10-13', '2036-10-13', '13-Oct-2026', '13-Oct-2036'];
  console.log('\nChecking target dates in Source Sheet:');
  for (const td of targetDates) {
    const matching = srcData.filter((r) => r.rawDate.includes(td));
    if (matching.length > 0) {
      const distinctReqNos = new Set(matching.map((r) => r.reqNo));
      console.log(`  Date "${td}": ${matching.length} rows, ${distinctReqNos.size} distinct ReqNos:`, Array.from(distinctReqNos));
    }
  }

  // Also search for any date containing '13-10' or '13/10' or '10-13' or '10/13'
  const anyOct13 = srcData.filter((r) => r.rawDate.includes('13/10') || r.rawDate.includes('13-10') || r.rawDate.includes('10/13') || r.rawDate.includes('10-13'));
  console.log(`\nAll source rows with 13 Oct in date: ${anyOct13.length} rows, distinct ReqNos: ${new Set(anyOct13.map((r) => r.reqNo)).size}`);
  const oct13DateStrings = new Set(anyOct13.map((r) => r.rawDate));
  console.log('Oct 13 date strings in source:', Array.from(oct13DateStrings));

  // ---------------------------------------------------------------------------
  // B. INSPECT LIVE ERP API
  // ---------------------------------------------------------------------------
  console.log('\n--- B. LIVE ERP API (Port 4001/8080) ---');
  // 1. Query without date filter
  const allReqRes = await apiRequest('/requisitions?pageSize=1', 'GET', null, token);
  console.log('Total Requisitions in ERP (headers):', allReqRes.data.meta?.total);

  // 2. Query for 2026-10-13
  const erp2026_10_13 = await apiRequest('/requisitions?dateFrom=2026-10-13&dateTo=2026-10-13&pageSize=100', 'GET', null, token);
  console.log(`ERP Requisitions for 2026-10-13: ${erp2026_10_13.data.meta?.total} headers returned:`);
  for (const r of erp2026_10_13.data.data.slice(0, 10)) {
    console.log(`  - ${r.requisitionNo} | Date: ${r.requisitionDate} | Status: ${r.status} | Lines: ${r.lineCount} | Items: ${r.itemCodes}`);
  }

  // 3. Query for 2036-10-13
  const erp2036_10_13 = await apiRequest('/requisitions?dateFrom=2036-10-13&dateTo=2036-10-13&pageSize=100', 'GET', null, token);
  console.log(`ERP Requisitions for 2036-10-13: ${erp2036_10_13.data.meta?.total} headers returned`);

  // ---------------------------------------------------------------------------
  // C. INSPECT DESTINATION DATABASE SPREADSHEET
  // ---------------------------------------------------------------------------
  console.log('\n--- C. DESTINATION SPREADSHEET (1v-r7cdHsnWBPJhe7RgaNYgnl5T7kPhvAIIf58-q770g) ---');
  const destRes = await sheets.spreadsheets.values.get({
    spreadsheetId: env.GOOGLE_DB_SPREADSHEET_ID,
    range: "'Requisition'!A1:AH",
    valueRenderOption: 'FORMATTED_VALUE',
  });
  const destRows = destRes.data.values ?? [];
  const destHeaders = destRows[0] ?? [];
  console.log('Destination Headers:', destHeaders);

  const destData = destRows.slice(1).map((r, i) => ({
    rowNum: i + 2,
    reqId: r[0] ?? '',
    reqLineId: r[1] ?? '',
    reqNo: (r[2] ?? '').trim(),
    reqDate: (r[3] ?? '').trim(),
    itemCode: (r[7] ?? '').trim(),
    itemName: (r[8] ?? '').trim(),
    qty: r[11] ?? '',
    dept: r[15] ?? '',
    status: r[19] ?? '',
  }));
  console.log('Total Destination Requisition rows:', destData.length);

  for (const td of ['2026-10-13', '2036-10-13', '13-10-2026', '13/10/2026']) {
    const matching = destData.filter((r) => r.reqDate.includes(td));
    if (matching.length > 0) {
      const distinctReqNos = new Set(matching.map((r) => r.reqNo));
      console.log(`  Dest Date "${td}": ${matching.length} rows, ${distinctReqNos.size} distinct ReqNos:`, Array.from(distinctReqNos).slice(0, 10));
    }
  }

  // Group dest rows for 2026-10-13
  const destOct13 = destData.filter((r) => r.reqDate === '2026-10-13');
  const destOct13ReqMap = new Map<string, number>();
  for (const r of destOct13) {
    destOct13ReqMap.set(r.reqNo, (destOct13ReqMap.get(r.reqNo) ?? 0) + 1);
  }
  console.log(`\nDestination total rows for 2026-10-13: ${destOct13.length}`);
  console.log(`Destination distinct ReqNos for 2026-10-13: ${destOct13ReqMap.size}`);
}

main().catch(console.error);
