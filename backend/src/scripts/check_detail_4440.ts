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
    range: "'Requisition'!A4440:I4455",
  });
  for (let i = 0; i < (res.data.values || []).length; i++) {
    const r = res.data.values[i];
    console.log(`Row ${4440 + i}: SrNo="${r[0]}", Date="${r[1]}", ReqNo="${r[2]}", ItemCode="${r[3]}", ItemName="${r[4]}", Qty="${r[5]}", Group="${r[7]}", User="${r[8]}"`);
  }
}

main().catch(console.error);
