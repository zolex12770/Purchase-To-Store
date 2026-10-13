import { google } from 'googleapis';
import { GoogleAuth } from 'google-auth-library';
import { env } from '../config/env.js';

async function checkGrnEnd() {
  const auth = new GoogleAuth({
    keyFile: env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const sheets = google.sheets({ version: 'v4', auth });
  const destId = env.GOOGLE_DB_SPREADSHEET_ID;

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: destId,
    range: `'GRN'!A4914:D4918`,
  });
  console.log('Rows 4914-4918 count:', res.data.values?.length);
  for (let i = 0; i < (res.data.values || []).length; i++) {
    console.log(`Row ${4914 + i}:`, JSON.stringify(res.data.values?.[i]));
  }
}

checkGrnEnd().catch(console.error);
