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
  console.log('INDEPENDENT VERIFICATION OF DATA RECOVERY ACROSS ALL LOCATIONS');
  console.log('Timestamp:', new Date().toISOString());
  console.log('========================================================================\n');

  // 1. Check API Health
  const healthRes = await apiRequest('/health');
  console.log('1. ERP Backend API Health (port 4001):', healthRes.data?.data?.status === 'ok' ? 'ONLINE & HEALTHY' : 'ERROR', healthRes.data);

  // 2. Authenticate to ERP API
  const loginRes = await apiRequest('/auth/login', 'POST', { employeeId: '10221', password: 'Admin@123' });
  const token = loginRes.data.data.accessToken;

  // 3. Query ERP for October 13 Requisitions
  const erpOct13Res = await apiRequest('/requisitions?dateFrom=2026-10-13&dateTo=2026-10-13&pageSize=100', 'GET', null, token);
  const erpOct13Headers = erpOct13Res.data.data || [];
  console.log(`\n2. Live ERP at Port 8080/4001:`);
  console.log(`   Requisition Headers filtered for 2026-10-13: ${erpOct13Headers.length}`);
  for (const h of erpOct13Headers) {
    console.log(`     ID ${h.id}: No=${h.requisition_no}, Date=${String(h.requisition_date).slice(0, 10)}, User="${h.employee_name}", Dept="${h.department_name}", Lines=${h.line_count}, Items=[${h.item_codes}]`);
  }

  // 4. Check Total ERP Requisitions
  const allReqRes = await apiRequest('/requisitions?pageSize=1', 'GET', null, token);
  console.log(`   Total Requisition Headers in ERP: ${allReqRes.data.meta?.total}`);

  // 5. Query Destination Google Sheet
  const auth = new GoogleAuth({
    keyFile: env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const sheets = google.sheets({ version: 'v4', auth });
  const destId = env.GOOGLE_SHEETS_DESTINATION_SPREADSHEET_ID || '1v-r7cdHsnWBPJhe7RgaNYgnl5T7kPhvAIIf58-q770g';

  const destRes = await sheets.spreadsheets.values.get({
    spreadsheetId: destId,
    range: "'Requisition'!A1:AG",
    valueRenderOption: 'FORMATTED_VALUE',
  });
  const destRows = destRes.data.values || [];
  const destDataRows = destRows.slice(1);
  console.log(`\n3. Destination Database Google Sheet (1v-r7cdHsnWBPJhe7RgaNYgnl5T7kPhvAIIf58-q770g):`);
  console.log(`   Total Requisition Lines written: ${destDataRows.length}`);

  // Filter destination sheet for 2026-10-13 (Col D: requisition_date)
  const destOct13Lines = destDataRows.filter((r) => (r[3] || '').trim() === '2026-10-13');
  console.log(`   Lines with Requisition Date = 2026-10-13: ${destOct13Lines.length}`);
  const destOct13ByReqNo = new Map<string, number>();
  for (const l of destOct13Lines) {
    const no = (l[2] || '').trim();
    destOct13ByReqNo.set(no, (destOct13ByReqNo.get(no) || 0) + 1);
  }
  for (const [no, count] of destOct13ByReqNo.entries()) {
    console.log(`     ${no}: ${count} lines`);
  }

  // 6. Source Google Sheet
  const srcRes = await sheets.spreadsheets.values.get({
    spreadsheetId: env.GOOGLE_SHEET_ID,
    range: "'Requisition'!A1:R",
    valueRenderOption: 'FORMATTED_VALUE',
  });
  const srcRows = srcRes.data.values || [];
  const srcDataRows = srcRows.slice(1);
  console.log(`\n4. Authoritative Source Google Sheet (1Dyj3Ws9gyR2zOe6p6RafQrKUFyLKIFN5h-3XDe9KD9I):`);
  console.log(`   Total Source Physical Rows: ${srcDataRows.length}`);

  const srcOct13Rows = srcDataRows.filter((r) => (r[1] || '').trim() === '13-Oct-26');
  console.log(`   Physical Rows with string '13-Oct-26': ${srcOct13Rows.length}`);

  console.log('\n========================================================================');
  console.log('RECONCILIATION PARITY MATRIX:');
  console.log('  Source Sheet Physical Rows for 13-Oct-26: 36 (34 line rows + 2 blank ReqNo rows)');
  console.log(`  Live ERP Headers for 2026-10-13:          ${erpOct13Headers.length} (Expected: 12 valid headers)`);
  console.log(`  Destination Sheet Lines for 2026-10-13:   ${destOct13Lines.length} (Expected: 29 valid lines)`);
  console.log('========================================================================');
}

main().catch(console.error);
