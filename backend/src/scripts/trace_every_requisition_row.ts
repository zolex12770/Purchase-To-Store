import { google } from 'googleapis';
import { GoogleAuth } from 'google-auth-library';
import { env } from '../config/env.js';

function parseDate(raw: unknown): string {
  if (!raw) return new Date().toISOString().slice(0, 10);
  const s = String(raw).trim();

  // Excel serial number (e.g. 45570)
  if (/^\d{5}$/.test(s)) {
    const serial = parseInt(s, 10);
    const utcDays = serial - 25569;
    const date = new Date(utcDays * 86400 * 1000);
    return date.toISOString().slice(0, 10);
  }

  // DD/MM/YYYY or DD-MM-YYYY
  const dmyMatch = s.match(/^(\d{1,2})[\/\.-](\d{1,2})[\/\.-](\d{2,4})$/);
  if (dmyMatch) {
    const day = dmyMatch[1]!.padStart(2, '0');
    const month = dmyMatch[2]!.padStart(2, '0');
    let year = dmyMatch[3]!;
    if (year.length === 2) year = '20' + year;
    return `${year}-${month}-${day}`;
  }

  // YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    return s.slice(0, 10);
  }

  const d = new Date(s);
  if (!isNaN(d.getTime())) {
    return d.toISOString().slice(0, 10);
  }
  return new Date().toISOString().slice(0, 10);
}

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
      range: "'Requisition'!A1:ZZ",
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

  const reqRaw = (reqRes.data.values ?? []).map((r) =>
    (r ?? []).map((c) => (c === null || c === undefined ? '' : String(c).trim()))
  );

  const reqDataRows = reqRaw.slice(1).filter((r) => r.some((c) => c && c.trim()));
  console.log(`Total reqDataRows: ${reqDataRows.length}`);

  let missingReqNo = 0;
  let missingItemCode = 0;
  let itemNotInMaster = 0;
  let zeroQty = 0;
  let validLine = 0;

  const reqGroups = new Map<string, Array<{ rowIdx: number; row: string[] }>>();
  for (let i = 0; i < reqDataRows.length; i++) {
    const r = reqDataRows[i]!;
    const reqNo = (r[2] || '').trim();
    if (!reqNo) {
      missingReqNo++;
      continue;
    }
    if (!reqGroups.has(reqNo)) reqGroups.set(reqNo, []);
    reqGroups.get(reqNo)!.push({ rowIdx: i + 2, row: r });
  }

  console.log(`Rows missing ReqNo (skipped): ${missingReqNo}`);
  console.log(`Distinct ReqGroups: ${reqGroups.size}`);

  let groupsWithZeroValidLines = 0;
  let groupsImported = 0;
  let totalValidLines = 0;
  const skippedGroups: Array<{ reqNo: string; count: number; reasons: string[] }> = [];

  for (const [reqNo, entries] of reqGroups.entries()) {
    let groupValidLines = 0;
    const reasons: string[] = [];

    for (const e of entries) {
      const itCode = (e.row[3] || '').trim();
      const reqQty = parseNum(e.row[5]);
      const issuedQty = parseNum(e.row[16]);

      if (!itCode) {
        missingItemCode++;
        reasons.push(`Row ${e.rowIdx}: missing item code`);
        continue;
      }
      if (!itemMap.has(itCode) && !itemMap.has(itCode.toUpperCase())) {
        itemNotInMaster++;
        reasons.push(`Row ${e.rowIdx}: item ${itCode} not in master`);
        continue;
      }
      if (reqQty <= 0 && issuedQty <= 0) {
        zeroQty++;
        reasons.push(`Row ${e.rowIdx}: reqQty and issuedQty both 0`);
        continue;
      }
      validLine++;
      groupValidLines++;
    }

    if (groupValidLines === 0) {
      groupsWithZeroValidLines++;
      skippedGroups.push({ reqNo, count: entries.length, reasons });
    } else {
      groupsImported++;
      totalValidLines += groupValidLines;
    }
  }

  console.log('\n--- LINE CLASSIFICATION SUMMARY ---');
  console.log(`Valid Lines to import: ${validLine}`);
  console.log(`Lines with Item Code NOT in Item Master: ${itemNotInMaster}`);
  console.log(`Lines missing Item Code: ${missingItemCode}`);
  console.log(`Lines with Zero/Blank Qty: ${zeroQty}`);
  console.log(`Lines missing ReqNo: ${missingReqNo}`);
  console.log(`Sum: ${validLine + itemNotInMaster + missingItemCode + zeroQty + missingReqNo} vs ${reqDataRows.length}`);

  console.log('\n--- HEADER CLASSIFICATION SUMMARY ---');
  console.log(`Groups imported as Headers: ${groupsImported}`);
  console.log(`Groups skipped (0 valid lines): ${groupsWithZeroValidLines}`);
  console.log('Sample skipped groups:', skippedGroups.slice(0, 10));
}

main().catch(console.error);
