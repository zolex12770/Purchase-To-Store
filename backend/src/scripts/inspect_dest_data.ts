import { google } from 'googleapis';
import { GoogleAuth } from 'google-auth-library';
import { env } from '../config/env.js';

async function inspectDestData() {
  const auth = new GoogleAuth({
    keyFile: env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const sheets = google.sheets({ version: 'v4', auth });
  const destId = env.GOOGLE_DB_SPREADSHEET_ID;

  for (const tab of ['Item Master', 'Supplier Master', 'Purchase Indent', 'Purchase Order', 'GRN', 'Requisition', 'Stock Ledger']) {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: destId,
      range: `'${tab}'!A1:O10`,
    });
    const rows = res.data.values || [];
    console.log(`\n=== TAB: [${tab}] ===`);
    console.log(`Row 1 (Header):`, JSON.stringify(rows[0] || []));
    console.log(`Row 2:`, JSON.stringify(rows[1] || []));
    console.log(`Row 3:`, JSON.stringify(rows[2] || []));
    console.log(`Total rows returned in A1:O10: ${rows.length}`);
  }
}

inspectDestData();
