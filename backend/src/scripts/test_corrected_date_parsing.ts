import { google } from 'googleapis';
import { GoogleAuth } from 'google-auth-library';
import { env } from '../config/env.js';

const MONTH_NAMES: Record<string, string> = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

function parseDateRobust(raw: unknown): string | null {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;

  // 1. DD-Mon-YY or DD-Mon-YYYY (e.g. 13-Oct-26, 01-Aug-26, 25-Sep-2026)
  const dMonMatch = s.match(/^(\d{1,2})[-/ ]([A-Za-z]{3})[-/ ](\d{2,4})$/);
  if (dMonMatch) {
    const day = dMonMatch[1]!.padStart(2, '0');
    const monStr = dMonMatch[2]!.toLowerCase();
    const month = MONTH_NAMES[monStr];
    let year = dMonMatch[3]!;
    if (year.length === 2) year = '20' + year;
    if (month) return `${year}-${month}-${day}`;
  }

  // 2. Excel serial number (e.g. 46308)
  if (/^\d{5}$/.test(s)) {
    const serial = parseInt(s, 10);
    const utcDays = serial - 25569;
    const date = new Date(utcDays * 86400 * 1000);
    return date.toISOString().slice(0, 10);
  }

  // 3. DD/MM/YYYY or DD-MM-YYYY
  const dmyMatch = s.match(/^(\d{1,2})[\/\.-](\d{1,2})[\/\.-](\d{2,4})$/);
  if (dmyMatch) {
    const day = dmyMatch[1]!.padStart(2, '0');
    const month = dmyMatch[2]!.padStart(2, '0');
    let year = dmyMatch[3]!;
    if (year.length === 2) year = '20' + year;
    return `${year}-${month}-${day}`;
  }

  // 4. YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    return s.slice(0, 10);
  }

  return null;
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
    range: "'Requisition'!A1:R",
    valueRenderOption: 'FORMATTED_VALUE',
  });
  const rows = (res.data.values || []).slice(1);
  console.log(`Total data rows: ${rows.length}`);

  // Test parseDateRobust on 13-Oct-26
  console.log('parseDateRobust("13-Oct-26") =', parseDateRobust('13-Oct-26'));
  console.log('parseDateRobust("01-Aug-26") =', parseDateRobust('01-Aug-26'));
  console.log('parseDateRobust("46308") =', parseDateRobust('46308'));

  // Forward fill dates in sheet sequence
  let lastKnownDate: string | null = null;
  const rowResolvedDates: Array<{ rowIdx: number; reqNo: string; rawDate: string; resolvedDate: string | null; inherited: boolean }> = [];

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    const rawDate = (r[1] || '').trim();
    const reqNo = (r[2] || '').trim();
    const parsed = parseDateRobust(rawDate);

    if (parsed) {
      lastKnownDate = parsed;
      rowResolvedDates.push({ rowIdx: i + 2, reqNo, rawDate, resolvedDate: parsed, inherited: false });
    } else {
      // Inherit last known date if blank
      rowResolvedDates.push({ rowIdx: i + 2, reqNo, rawDate, resolvedDate: lastKnownDate, inherited: true });
    }
  }

  // Group by ReqNo
  const reqGroups = new Map<string, typeof rowResolvedDates>();
  for (const r of rowResolvedDates) {
    if (!r.reqNo) continue;
    if (!reqGroups.has(r.reqNo)) reqGroups.set(r.reqNo, []);
    reqGroups.get(r.reqNo)!.push(r);
  }

  console.log(`Total ReqGroups: ${reqGroups.size}`);

  // Determine group date: prefer explicit date in group, then inherited date
  const groupDates = new Map<string, { date: string; rows: number; reqNo: string }>();
  for (const [reqNo, entries] of reqGroups.entries()) {
    const explicitEntry = entries.find((e) => !e.inherited && e.resolvedDate);
    const resolvedDate = explicitEntry ? explicitEntry.resolvedDate! : (entries[0]!.resolvedDate || '1970-01-01');
    groupDates.set(reqNo, { date: resolvedDate, rows: entries.length, reqNo });
  }

  // Check counts for 2026-10-13!
  const oct13Groups = Array.from(groupDates.values()).filter((g) => g.date === '2026-10-13');
  const oct13TotalLines = oct13Groups.reduce((acc, g) => acc + g.rows, 0);

  console.log(`\n======================================================`);
  console.log(`REQUISITIONS ON 2026-10-13 WITH CORRECTED PARSING:`);
  console.log(`======================================================`);
  console.log(`Distinct ReqNos (Headers): ${oct13Groups.length}`);
  console.log(`Total Line Items (Source Rows): ${oct13TotalLines}`);
  console.log('List of ReqNos on 2026-10-13:');
  for (const g of oct13Groups) {
    console.log(`  ${g.reqNo}: ${g.rows} lines`);
  }

  // Check what dates were assigned to the 51 old blank-date ReqNos!
  console.log('\nWhere did the previously blank-date ReqNos go?');
  for (const sample of ['RN-0121', 'RN-0231', 'RN-0234', 'RN-0364', 'RN-0370', 'RN-0608', 'RN-0611']) {
    const g = groupDates.get(sample);
    if (g) {
      console.log(`  ${sample}: resolved to Date "${g.date}" (${g.rows} lines)`);
    }
  }
}

main().catch(console.error);
