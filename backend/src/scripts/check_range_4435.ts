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
    range: "'Requisition'!A4435:C4455",
  });
  console.log('Rows 4435 to 4455:');
  for (let i = 0; i < (res.data.values || []).length; i++) {
    console.log(`Row ${4435 + i}:`, res.data.values[i]);
  }
}

main().catch(console.error);
