import { google } from 'googleapis';
import { GoogleAuth } from 'google-auth-library';
import { env } from '../config/env.js';

async function main() {
  const auth = new GoogleAuth({
    keyFile: env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  console.log('Fetching source Requisition rows...');
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: env.GOOGLE_SHEET_ID,
    range: "'Requisition'!A1:R",
    valueRenderOption: 'FORMATTED_VALUE',
  });
  const rows = res.data.values || [];

  const rawRes = await sheets.spreadsheets.values.get({
    spreadsheetId: env.GOOGLE_SHEET_ID,
    range: "'Requisition'!A1:R",
    valueRenderOption: 'UNFORMATTED_VALUE',
  });
  const rawRows = rawRes.data.values || [];

  // Inspect the 36 rows that have '13-Oct-26'
  console.log('\n--- ALL 36 ROWS WITH "13-Oct-26" IN SOURCE ---');
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const rawR = rawRows[i] || [];
    if ((r[1] || '').trim() === '13-Oct-26') {
      console.log(`Row ${i + 1}: Date="${r[1]}" (Raw: ${rawR[1]}), ReqNo="${r[2]}", ItemCode="${r[3]}", ItemName="${r[4]}", ReqQty="${r[5]}", User="${r[8]}", Dept="${r[9]}", Status="${r[13]}", IssueSlip="${r[14]}"`);
    }
  }

  // Check Item Master to see if those item codes exist in Item Master
  const itemRes = await sheets.spreadsheets.values.get({
    spreadsheetId: env.GOOGLE_SHEET_ID,
    range: "'Item Master'!A2:B",
    valueRenderOption: 'FORMATTED_VALUE',
  });
  const itemMasterCodes = new Set((itemRes.data.values || []).map((r) => (r[0] || '').trim()));
  console.log(`\nTotal items in Item Master: ${itemMasterCodes.size}`);

  console.log('\nChecking Item Master presence for the 36 rows of 13-Oct-26:');
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if ((r[1] || '').trim() === '13-Oct-26') {
      const itCode = (r[3] || '').trim();
      const inMaster = itemMasterCodes.has(itCode);
      console.log(`  Row ${i + 1} (Req ${r[2]}): ItemCode="${itCode}" -> In Item Master: ${inMaster}`);
    }
  }
}

main().catch(console.error);
