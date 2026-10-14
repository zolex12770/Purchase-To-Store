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
    range: "'Requisition'!A4515:R4560",
    valueRenderOption: 'FORMATTED_VALUE',
  });
  const rows = res.data.values || [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    console.log(`Row ${4515 + i}: SrNo="${r[0]}", Date="${r[1]}", ReqNo="${r[2]}", ItemCode="${r[3]}", ItemName="${r[4]}", Qty="${r[5]}"`);
  }
}

main().catch(console.error);
