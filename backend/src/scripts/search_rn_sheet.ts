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
    range: "'Requisition'!A1:C",
  });
  const rows = res.data.values || [];
  const targets = ['1130', '1124', '1126', '1120', '1097', '1067', '1063', '1052', '1032', '1017', '0919', '0859'];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const val = (r[2] || '').trim();
    for (const t of targets) {
      if (val.includes(t)) {
        console.log(`Row ${i + 1}: SrNo="${r[0]}", Date="${r[1]}", ReqNo="${val}"`);
      }
    }
  }
}

main().catch(console.error);
