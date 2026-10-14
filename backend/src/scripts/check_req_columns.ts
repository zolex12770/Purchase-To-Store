import { google } from 'googleapis';
import { GoogleAuth } from 'google-auth-library';
import { env } from '../config/env.js';

async function main() {
  const auth = new GoogleAuth({
    keyFile: env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: env.GOOGLE_SHEET_ID,
    range: "'Requisition'!A1:R10",
    valueRenderOption: 'FORMATTED_VALUE',
  });
  const rows = res.data.values || [];
  console.log('Headers (Row 1):');
  for (let c = 0; c < (rows[0] || []).length; c++) {
    console.log(`  Col ${c}: "${rows[0][c]}"`);
  }

  // Also check rows 4522-4530
  const tailRes = await sheets.spreadsheets.values.get({
    spreadsheetId: env.GOOGLE_SHEET_ID,
    range: "'Requisition'!A4522:R4530",
    valueRenderOption: 'FORMATTED_VALUE',
  });
  console.log('\nRows 4522-4530:');
  for (let i = 0; i < (tailRes.data.values || []).length; i++) {
    const r = tailRes.data.values[i];
    console.log(`Row ${4522 + i}:`);
    for (let c = 0; c < r.length; c++) {
      if (r[c]) console.log(`   [Col ${c}]: "${r[c]}"`);
    }
  }
}

main().catch(console.error);
