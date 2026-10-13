import { google } from 'googleapis';
import { GoogleAuth } from 'google-auth-library';
import { env } from '../config/env.js';

async function checkAndExpandGrid() {
  const auth = new GoogleAuth({
    keyFile: env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });
  const destId = env.GOOGLE_DB_SPREADSHEET_ID;

  const meta = await sheets.spreadsheets.get({ spreadsheetId: destId });
  console.log('--- CURRENT GRID PROPERTIES ---');

  const requiredRows: Record<string, number> = {
    'Item Master': 4000,
    'Supplier Master': 2000,
    'Purchase Indent': 1000,
    'Purchase Order': 1000,
    'GRN': 6000,
    'Requisition': 4500,
    'Stock Ledger': 6000,
    'User Master': 1000,
    'History & Audit': 1000,
    'Indent / PO / GRN Type': 1000,
    'Lookup & Configuration': 2000,
  };

  const requests: any[] = [];

  for (const s of meta.data.sheets || []) {
    const title = s.properties?.title || '';
    const sheetId = s.properties?.sheetId;
    const currentRows = s.properties?.gridProperties?.rowCount || 1000;
    const req = requiredRows[title] || 1000;

    console.log(`Sheet [${title.padEnd(25)}] ID: ${sheetId}, Current Rows: ${currentRows}, Required: ${req}`);

    if (currentRows < req) {
      console.log(`  -> Needs expansion to ${req} rows`);
      requests.push({
        updateSheetProperties: {
          properties: {
            sheetId,
            gridProperties: {
              rowCount: req,
            },
          },
          fields: 'gridProperties.rowCount',
        },
      });
    }
  }

  if (requests.length > 0) {
    console.log(`\nExecuting batchUpdate to expand ${requests.length} sheets...`);
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: destId,
      requestBody: { requests },
    });
    console.log('✓ Sheets successfully expanded!');
  } else {
    console.log('\nAll sheets have sufficient grid rows.');
  }
}

checkAndExpandGrid();
