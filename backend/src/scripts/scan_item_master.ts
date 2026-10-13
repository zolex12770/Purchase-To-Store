import { google } from 'googleapis';
import { GoogleAuth } from 'google-auth-library';
import { env } from '../config/env.js';

async function scanAllTabs() {
  const auth = new GoogleAuth({
    keyFile: env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const sheets = google.sheets({ version: 'v4', auth });
  const destId = env.GOOGLE_DB_SPREADSHEET_ID;

  const tabs = [
    'Item Master', 'Supplier Master', 'Purchase Indent', 'Purchase Order',
    'GRN', 'Requisition', 'Stock Ledger', 'User Master',
    'History & Audit', 'Indent / PO / GRN Type', 'Lookup & Configuration'
  ];

  for (const tab of tabs) {
    const allA = await sheets.spreadsheets.values.get({
      spreadsheetId: destId,
      range: `'${tab}'!A:A`,
    });
    const aVals = allA.data.values || [];
    let first = -1, last = -1, count = 0;
    for (let i = 1; i < aVals.length; i++) {
      if (aVals[i] && aVals[i][0] && String(aVals[i][0]).trim()) {
        if (first === -1) first = i + 1;
        last = i + 1;
        count++;
      }
    }
    console.log(`Tab: [${tab.padEnd(25)}] Total rows: ${aVals.length}, Non-empty rows after header: ${count}, Range: Row ${first} to ${last}`);
  }
}

scanAllTabs();
