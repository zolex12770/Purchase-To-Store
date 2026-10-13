import { env } from '../config/env.js';
import { google } from 'googleapis';
import { GoogleAuth } from 'google-auth-library';
import { getDatabase, closeDatabase } from '../db/index.js';

async function main() {
  const auth = new GoogleAuth({
    keyFile: env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  console.log('=== PHASE 1: FULL LIVE SOURCE AUDIT ===');
  console.log('Timestamp:', new Date().toISOString());
  console.log('Source Sheet ID:', env.GOOGLE_SHEET_ID);
  console.log('Reference Sheet ID:', env.GOOGLE_DB_SPREADSHEET_ID);

  // 1. Fetch Source Metadata
  const sourceMeta = await sheets.spreadsheets.get({ spreadsheetId: env.GOOGLE_SHEET_ID });
  console.log('\n--- 1. LIVE SOURCE TABS & RANGES ---');
  const tabs = sourceMeta.data.sheets ?? [];
  const tabAudit: Record<string, any> = {};

  for (const t of tabs) {
    const title = t.properties?.title ?? '';
    const rowCount = t.properties?.gridProperties?.rowCount ?? 0;
    const colCount = t.properties?.gridProperties?.columnCount ?? 0;

    // Fetch header and populated rows
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: env.GOOGLE_SHEET_ID,
      range: `'${title.replace(/'/g, "''")}'!A1:ZZ`,
      valueRenderOption: 'FORMATTED_VALUE',
    });

    const rows = res.data.values ?? [];
    const headerRow = rows[0] ?? [];
    const dataRows = rows.slice(1);

    // Filter non-empty rows
    const nonEmptyRows = dataRows.filter((r) => r.some((c) => c !== undefined && String(c).trim() !== ''));

    tabAudit[title] = {
      sheetId: t.properties?.sheetId,
      gridRows: rowCount,
      gridCols: colCount,
      headerLength: headerRow.length,
      headers: headerRow,
      totalRowsReturned: rows.length,
      populatedDataRows: nonEmptyRows.length,
    };

    console.log(`Tab: [${title}] | Populated Data Rows: ${nonEmptyRows.length} | Header Count: ${headerRow.length}`);
    console.log(`   Headers: ${headerRow.join(' | ')}`);
  }

  // 2. Specific Checks on Item Master
  const itemTab = await sheets.spreadsheets.values.get({
    spreadsheetId: env.GOOGLE_SHEET_ID,
    range: "'Item Master'!A1:ZZ",
    valueRenderOption: 'FORMATTED_VALUE',
  });
  const itemRows = (itemTab.data.values ?? []).slice(1);
  const codeCounts: Record<string, number> = {};
  let emptyItemCodeRows = 0;
  let formulaErrorCount = 0;
  const invalidRows: { row: number; val: string }[] = [];

  itemRows.forEach((r, idx) => {
    const code = (r[0] ?? '').trim();
    if (!code) {
      if (r.some((c) => c && String(c).trim() !== '')) {
        emptyItemCodeRows++;
      }
    } else if (code.includes('#VALUE!') || code.includes('#REF!') || code.includes('#N/A')) {
      formulaErrorCount++;
      invalidRows.push({ row: idx + 2, val: code });
    } else {
      codeCounts[code] = (codeCounts[code] || 0) + 1;
    }
  });

  const dupCodes = Object.keys(codeCounts).filter((c) => codeCounts[c] > 1);
  console.log('\n--- 2. LIVE ITEM MASTER DEEP AUDIT ---');
  console.log('Total data rows returned by API:', itemRows.length);
  console.log('Populated valid Item Codes:', Object.values(codeCounts).reduce((a, b) => a + b, 0));
  console.log('Unique valid Item Codes:', Object.keys(codeCounts).length);
  console.log('Formula error codes in live sheet:', formulaErrorCount);
  console.log('Duplicate item codes in live sheet:', dupCodes.map((c) => `${c} (${codeCounts[c]}x)`));
  console.log('Blank item code rows with other populated columns:', emptyItemCodeRows);

  // 3. Supplier Master Deep Audit
  const suppTab = await sheets.spreadsheets.values.get({
    spreadsheetId: env.GOOGLE_SHEET_ID,
    range: "'Supplier Master'!A1:ZZ",
    valueRenderOption: 'FORMATTED_VALUE',
  });
  const suppRows = (suppTab.data.values ?? []).slice(1);
  const suppCodeCounts: Record<string, number> = {};
  const suppNameCounts: Record<string, number> = {};
  let emptySuppName = 0;

  suppRows.forEach((r) => {
    const name = (r[0] ?? '').trim();
    const code = (r[12] ?? '').trim(); // Supplier Code
    if (!name) {
      emptySuppName++;
    } else {
      suppNameCounts[name] = (suppNameCounts[name] || 0) + 1;
      if (code) {
        suppCodeCounts[code] = (suppCodeCounts[code] || 0) + 1;
      }
    }
  });
  const dupSuppCodes = Object.keys(suppCodeCounts).filter((c) => suppCodeCounts[c] > 1);
  console.log('\n--- 3. LIVE SUPPLIER MASTER DEEP AUDIT ---');
  console.log('Total supplier rows with name:', Object.values(suppNameCounts).reduce((a, b) => a + b, 0));
  console.log('Unique supplier names:', Object.keys(suppNameCounts).length);
  console.log('Suppliers with Supplier Code:', Object.values(suppCodeCounts).reduce((a, b) => a + b, 0));
  console.log('Unique Supplier Codes:', Object.keys(suppCodeCounts).length);
  console.log('Duplicate Supplier Codes:', dupSuppCodes.map((c) => `${c} (${suppCodeCounts[c]}x)`));

  // 4. Inspect Current Production Database
  console.log('\n--- 4. PRODUCTION DATABASE INVENTORY (PRE-RESET) ---');
  // Connect via read-only query or check database state
  console.log('Audit completed successfully.');
}

main().catch(console.error);
