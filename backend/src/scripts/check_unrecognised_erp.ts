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
  const auth = new GoogleAuth({
    keyFile: env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const sheets = google.sheets({ version: 'v4', auth });
  const srcRes = await sheets.spreadsheets.values.get({
    spreadsheetId: env.GOOGLE_SHEET_ID,
    range: "'Requisition'!A1:C",
  });
  const srcReqNos = new Set((srcRes.data.values || []).slice(1).map((r) => (r[2] || '').trim()).filter(Boolean));

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

  const unrecognised = erpHeaders.filter((h) => !srcReqNos.has(h.requisition_no));
  console.log(`ERP headers NOT in Source Sheet: ${unrecognised.length}`);
  for (const u of unrecognised) {
    console.log(`  ID ${u.id}: No="${u.requisition_no}", Date="${u.requisition_date}", Emp="${u.employee_name}", Lines=${u.line_count}`);
  }
}

main().catch(console.error);
