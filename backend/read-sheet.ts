/**
 * Reads the live replica spreadsheet WITHOUT opening the database, so it can be
 * run while the ERP is up (PGlite allows one process at a time).
 *
 *   npx tsx read-sheet.ts            # tab list with row/column counts
 *   npx tsx read-sheet.ts "GRN"      # that tab's header and first rows
 */
import { readFileSync } from 'node:fs';
import { google } from 'googleapis';
import { GoogleAuth } from 'google-auth-library';

function envValue(key: string): string {
  const text = readFileSync(new URL('./.env', import.meta.url), 'utf8');
  const line = text.split(/\r?\n/).find((l) => l.startsWith(`${key}=`));
  return line ? line.slice(key.length + 1).trim() : '';
}

async function main() {
  const spreadsheetId = envValue('GOOGLE_SHEETS_Database_SPREADSHEET_ID')
    || envValue('GOOGLE_SHEETS_DATABASE_SPREADSHEET_ID');
  const keyFile = envValue('GOOGLE_SERVICE_ACCOUNT_KEY_FILE');
  const auth = new GoogleAuth({ keyFile, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  const sheets = google.sheets({ version: 'v4', auth: auth as never });

  console.log(`spreadsheet: ${spreadsheetId}\n`);
  const meta = await sheets.spreadsheets.get({ spreadsheetId, includeGridData: false });
  const tabs = (meta.data.sheets ?? []).map((s) => ({
    title: String(s.properties?.title ?? ''),
    rows: Number(s.properties?.gridProperties?.rowCount ?? 0),
    cols: Number(s.properties?.gridProperties?.columnCount ?? 0),
  }));

  const wanted = process.argv[2];
  if (!wanted) {
    console.log(`title (${tabs.length} tabs)`.padEnd(30) + 'grid rows   data rows   cols');
    console.log('-'.repeat(66));
    let total = 0;
    for (const t of tabs) {
      const res = await sheets.spreadsheets.values.get({
        spreadsheetId, range: `'${t.title.replace(/'/g, "''")}'!A:A`,
      });
      const dataRows = Math.max(0, (res.data.values ?? []).length - 1);
      total += dataRows;
      console.log(
        `${t.title.padEnd(30)}${String(t.rows).padStart(9)}${String(dataRows).padStart(12)}${String(t.cols).padStart(7)}`,
      );
    }
    console.log('-'.repeat(66));
    console.log(`TOTAL DATA ROWS: ${total}`);
    return;
  }

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId, range: `'${wanted.replace(/'/g, "''")}'!A1:BZ6`,
  });
  const values = res.data.values ?? [];
  console.log(`HEADER (${(values[0] ?? []).length} columns):`);
  console.log((values[0] ?? []).map((h, i) => `${i + 1}. ${h}`).join('\n'));
  console.log('\nFIRST ROWS:');
  for (const row of values.slice(1, 4)) console.log('  ' + JSON.stringify(row));
}

main().catch((e) => { console.error(e.message); process.exit(1); });
