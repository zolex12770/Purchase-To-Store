import { env } from '../config/env.js';
import { google } from 'googleapis';
import { GoogleAuth } from 'google-auth-library';

async function main() {
  const auth = new GoogleAuth({
    keyFile: env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: env.GOOGLE_SHEET_ID,
    range: "'Item Master'!A1:O",
    valueRenderOption: 'FORMATTED_VALUE',
  });

  const rows = res.data.values ?? [];
  const targetCodes = new Set([
    'EL0779', 'PL050',
    '1161070001', '1161090001', '1161110001', '1161130001', '1161160050',
    '1161210001', '1161290001', '1161360001', '1161420001', '1161480001',
    '1609070001', '1609090001', '1609110001', '1609130001', '1609160001',
    '1609210001', '1609290001', '1609360001', '1609420001', '1609480001',
  ]);

  console.log('=== DUPLICATE ITEM CODE ROWS IN LIVE SHEET ===');
  rows.forEach((r, idx) => {
    const code = (r[0] ?? '').trim();
    if (targetCodes.has(code)) {
      console.log(`Row ${idx + 1}: Code=${code} | Name=${r[1]} | Desc=${r[2]} | Group=${r[4]} | SubGroup=${r[5]} | Unit=${r[6]}`);
    }
  });
}

main().catch(console.error);
