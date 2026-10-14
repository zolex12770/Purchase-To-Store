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
    range: "'Requisition'!A4500:S4535",
    valueRenderOption: 'FORMATTED_VALUE',
  });
  const rows = res.data.values || [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    console.log(`Sheet Row ${4500 + i}: SrNo="${r[0]}", Date="${r[1]}", ReqNo="${r[2]}", Item="${r[3]}", Qty="${r[5]}", UOM="${r[6]}", Group="${r[7]}", User="${r[8]}", Dept="${r[9]}"`);
  }
}

main().catch(console.error);
