import { google } from 'googleapis';
import { GoogleAuth } from 'google-auth-library';
import { env } from '../config/env.js';

function parseNum(raw: unknown): number {
  if (raw === null || raw === undefined) return 0;
  const s = String(raw).replace(/,/g, '').trim();
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

async function main() {
  const auth = new GoogleAuth({
    keyFile: env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  const [reqRes, itemRes] = await Promise.all([
    sheets.spreadsheets.values.get({
      spreadsheetId: env.GOOGLE_SHEET_ID,
      range: "'Requisition'!A1:R",
      valueRenderOption: 'FORMATTED_VALUE',
    }),
    sheets.spreadsheets.values.get({
      spreadsheetId: env.GOOGLE_SHEET_ID,
      range: "'Item Master'!A2:C",
      valueRenderOption: 'FORMATTED_VALUE',
    }),
  ]);

  const itemMap = new Map<string, boolean>();
  for (const r of itemRes.data.values || []) {
    const code = (r[0] || '').trim();
    if (code) {
      itemMap.set(code, true);
      itemMap.set(code.toUpperCase(), true);
    }
  }

  const reqRows = (reqRes.data.values || []).slice(1);
  const reqGroups = new Map<string, Array<{ rowIdx: number; row: string[] }>>();
  for (let i = 0; i < reqRows.length; i++) {
    const r = reqRows[i]!;
    const reqNo = (r[2] || '').trim();
    if (!reqNo) continue;
    if (!reqGroups.has(reqNo)) reqGroups.set(reqNo, []);
    reqGroups.get(reqNo)!.push({ rowIdx: i + 2, row: r });
  }

  const targetReqs = ['RN-1136', 'RN-1155', 'RN-1156', 'RN-1157', 'RN-1158', 'RN-1159', 'RN-1160', 'RN-1161', 'RN-1162', 'RN-1163', 'RN-1164', 'RN-1165', 'RN-1166', 'RN-0723'];

  for (const t of targetReqs) {
    const entries = reqGroups.get(t);
    if (!entries) {
      console.log(`ReqNo "${t}": NOT IN reqGroups!`);
      continue;
    }
    console.log(`\nAnalyzing "${t}" (${entries.length} entries in group):`);
    let validLinesCount = 0;
    for (const e of entries) {
      const itCode = (e.row[3] || '').trim();
      const reqQty = parseNum(e.row[5]);
      const inMaster = itemMap.has(itCode) || itemMap.has(itCode.toUpperCase());
      console.log(`  Row ${e.rowIdx}: itemCode="${itCode}", inMaster=${inMaster}, reqQty=${reqQty}`);
      if (inMaster && reqQty > 0) validLinesCount++;
    }
    console.log(`  -> validLinesCount: ${validLinesCount} (would insert header? ${validLinesCount > 0})`);
  }
}

main().catch(console.error);
