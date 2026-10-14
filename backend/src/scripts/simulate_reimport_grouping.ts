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

async function main() {
  const auth = new GoogleAuth({
    keyFile: env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  console.log('Fetching live Requisition tab...');
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: env.GOOGLE_SHEET_ID,
    range: "'Requisition'!A1:ZZ",
    valueRenderOption: 'FORMATTED_VALUE',
  });
  const reqRaw = (res.data.values ?? []).map((r) =>
    (r ?? []).map((c) => (c === null || c === undefined ? '' : String(c).trim()))
  );

  const reqDataRows = reqRaw.slice(1).filter((r) => r.some((c) => c && c.trim()));
  console.log(`Total reqDataRows: ${reqDataRows.length}`);

  const reqGroups = new Map<string, Array<{ rowIdx: number; row: string[] }>>();
  for (let i = 0; i < reqDataRows.length; i++) {
    const r = reqDataRows[i]!;
    const reqNo = (r[2] || '').trim();
    if (!reqNo) continue;
    if (!reqGroups.has(reqNo)) reqGroups.set(reqNo, []);
    reqGroups.get(reqNo)!.push({ rowIdx: i + 2, row: r });
  }

  console.log(`Total grouped ReqNos: ${reqGroups.size}`);

  // Let's check what date parseDate produces for each ReqNo!
  const dateToReqNos = new Map<string, string[]>();
  for (const [reqNo, entries] of reqGroups.entries()) {
    const first = entries[0]!.row;
    const rawDate = first[1] || '';
    const parsed = parseDate(rawDate);
    if (!dateToReqNos.has(parsed)) dateToReqNos.set(parsed, []);
    dateToReqNos.get(parsed)!.push(reqNo);
  }

  console.log('\n--- DATE DISTRIBUTION OF REQUISITION HEADERS ---');
  for (const [d, reqs] of Array.from(dateToReqNos.entries()).sort()) {
    if (d.includes('2026-10') || d.includes('2036') || d.includes('2026-08') || d.includes('2026-09')) {
      console.log(`Date "${d}": ${reqs.length} headers`);
    }
  }

  console.log('\nHeaders for 2026-10-13 (count = ' + (dateToReqNos.get('2026-10-13')?.length || 0) + '):');
  console.log(dateToReqNos.get('2026-10-13'));

  console.log('\nHeaders for 2026-10-12 (count = ' + (dateToReqNos.get('2026-10-12')?.length || 0) + '):');
  console.log(dateToReqNos.get('2026-10-12'));
}

main().catch(console.error);
