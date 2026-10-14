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

  // Check rows where date is blank
  const blankDateRows = rows.slice(1).map((r, i) => ({ rowIdx: i + 2, row: r })).filter((x) => !(x.row[1] || '').trim() && (x.row[2] || '').trim());
  console.log(`Total rows with Blank Requisition Date but non-blank ReqNo: ${blankDateRows.length}`);

  // Sample check: RN-0121, RN-0231, RN-0364, RN-0608
  for (const sampleReqNo of ['RN-0121', 'RN-0231', 'RN-0234', 'RN-0364', 'RN-0370', 'RN-0608']) {
    console.log(`\nInspecting ${sampleReqNo}:`);
    const matches = rows.slice(1).map((r, i) => ({ rowIdx: i + 2, row: r })).filter((x) => (x.row[2] || '').trim() === sampleReqNo);
    for (const m of matches) {
      console.log(`  Row ${m.rowIdx}: SrNo="${m.row[0]}", Date="${m.row[1]}", ReqNo="${m.row[2]}", Item="${m.row[3]}", User="${m.row[8]}", Dept="${m.row[9]}", IssueSlip="${m.row[14]}", IssueDate="${m.row[15]}"`);
    }
    // Check surrounding rows in source sheet to see what date was nearby!
    if (matches.length > 0) {
      const firstRowIdx = matches[0].rowIdx;
      console.log(`  Surrounding context for ${sampleReqNo} (rows ${firstRowIdx - 3} to ${firstRowIdx + 1}):`);
      for (let j = Math.max(1, firstRowIdx - 3); j <= Math.min(rows.length, firstRowIdx + 1); j++) {
        const r = rows[j - 1];
        console.log(`    Row ${j}: Date="${r[1]}", ReqNo="${r[2]}", Item="${r[3]}"`);
      }
    }
  }
}

main().catch(console.error);
