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
    range: "'Requisition'!A1:R",
    valueRenderOption: 'FORMATTED_VALUE',
  });
  const rows = res.data.values || [];

  for (const target of ['RN-1135', 'RN-1136', 'RN-1137', 'RN-1153', 'RN-1154', 'RN-1155', 'RN-1156', 'RN-1157', 'RN-1158']) {
    console.log(`\nSearching for "${target}":`);
    const matches = rows.slice(1).map((r, i) => ({ rowIdx: i + 2, row: r })).filter((x) => (x.row[2] || '').trim() === target);
    for (const m of matches) {
      console.log(`  Row ${m.rowIdx}: Date="${m.row[1]}", ReqNo="${m.row[2]}", ItemCode="${m.row[3]}", Qty="${m.row[5]}", User="${m.row[8]}", Dept="${m.row[9]}"`);
    }
  }
}

main().catch(console.error);
