import { google } from 'googleapis';
import { GoogleAuth } from 'google-auth-library';
import http from 'node:http';
import { env } from '../config/env.js';
import { scriptApiTarget, scriptCredentials } from './script-target.js';

// Target and account come from the environment; production needs ZOLEX_ALLOW_PRODUCTION=yes.
const SCRIPT_API = scriptApiTarget();
const SCRIPT_LOGIN = scriptCredentials();

function apiRequest(endpoint: string, token: string): Promise<any> {
  return new Promise((resolve, reject) => {
    http.get(
      {
        hostname: SCRIPT_API.hostname,
        port: SCRIPT_API.port,
        path: '/api/v1' + endpoint,
        headers: { Authorization: 'Bearer ' + token },
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => resolve(JSON.parse(raw)));
      },
    ).on('error', reject);
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
    range: "'Requisition'!A1:R",
  });
  const rows = (srcRes.data.values || []).slice(1);

  // Map item code to sheet rows
  const itemToSheetRows = new Map<string, Array<{ rowIdx: number; reqNo: string; date: string; user: string }>>();
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    const item = (r[3] || '').trim();
    if (!item) continue;
    if (!itemToSheetRows.has(item)) itemToSheetRows.set(item, []);
    itemToSheetRows.get(item)!.push({
      rowIdx: i + 2,
      reqNo: (r[2] || '').trim(),
      date: (r[1] || '').trim(),
      user: (r[8] || '').trim(),
    });
  }

  const loginRes = await new Promise<any>((resolve, reject) => {
    const req = http.request(
      {
        hostname: SCRIPT_API.hostname,
        port: SCRIPT_API.port,
        path: '/api/v1/auth/login',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => resolve(JSON.parse(raw)));
      },
    );
    req.write(JSON.stringify(SCRIPT_LOGIN));
    req.end();
  });
  const token = loginRes.data.accessToken;

  console.log('Comparing ERP Headers 1240-1270 to Sheet:');
  for (let id = 1240; id <= 1270; id++) {
    const res = await apiRequest(`/requisitions/${id}`, token);
    if (!res.data) continue;
    const h = res.data;
    const lines = h.lines || [];
    const firstLine = lines[0];
    const sheetMatches = firstLine ? itemToSheetRows.get(firstLine.item_code) || [] : [];
    // find sheet match with same requested_qty or near row 4400-4550
    const nearby = sheetMatches.filter((m) => m.rowIdx >= 4400);
    console.log(
      `ID ${id}: DB_ReqNo="${h.requisition_no}", Date="${String(h.requisition_date).slice(0, 10)}", Lines=${lines.length}, FirstItem="${firstLine?.item_code}" -> Sheet Matches >= row 4400: ${nearby.map((n) => `Row ${n.rowIdx}(ReqNo=${n.reqNo}, User=${n.user})`).join(' | ')}`
    );
  }
}

main().catch(console.error);
