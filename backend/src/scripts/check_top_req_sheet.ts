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
    range: "'Requisition'!A1:C15",
  });
  console.log('First 15 rows of Requisition A1:C15:');
  for (let i = 0; i < (res.data.values || []).length; i++) {
    console.log(`Row ${i + 1}:`, res.data.values[i]);
  }
}

main().catch(console.error);
