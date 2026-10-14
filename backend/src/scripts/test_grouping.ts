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
    range: "'Requisition'!A1:ZZ",
    valueRenderOption: 'FORMATTED_VALUE',
  });
  const reqRaw = (res.data.values ?? []).map((r) =>
    (r ?? []).map((c) => (c === null || c === undefined ? '' : String(c).trim()))
  );

  const reqDataRows = reqRaw.slice(1).filter((r) => r.some((c) => c && c.trim()));

  const reqGroups = new Map<string, Array<{ rowIdx: number; row: string[] }>>();
  for (let i = 0; i < reqDataRows.length; i++) {
    const r = reqDataRows[i]!;
    const reqNo = (r[2] || '').trim();
    if (!reqNo) continue;
    if (!reqGroups.has(reqNo)) reqGroups.set(reqNo, []);
    reqGroups.get(reqNo)!.push({ rowIdx: i + 2, row: r });
  }

  // Let's inspect the groups for RN-1153, RN-1154, RN-1155, RN-1156, RN-1157, RN-1158
  for (const no of ['RN-1153', 'RN-1154', 'RN-1155', 'RN-1156', 'RN-1157', 'RN-1158']) {
    const g = reqGroups.get(no);
    console.log(`\nGroup "${no}": ${g ? g.length : 0} rows:`);
    if (g) {
      for (const item of g) {
        console.log(`  Row ${item.rowIdx}: ReqNo="${item.row[2]}", Item="${item.row[3]}", Qty="${item.row[5]}", User="${item.row[8]}"`);
      }
    }
  }
}

main().catch(console.error);
