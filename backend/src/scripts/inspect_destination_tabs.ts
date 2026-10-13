import { google } from 'googleapis';
import { GoogleAuth } from 'google-auth-library';
import { env } from '../config/env.js';

async function inspectTabs() {
  const auth = new GoogleAuth({
    keyFile: env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const sheets = google.sheets({ version: 'v4', auth });
  const destId = env.GOOGLE_DB_SPREADSHEET_ID;

  const res = await sheets.spreadsheets.get({
    spreadsheetId: destId,
  });

  console.log('DESTINATION SPREADSHEET TABS:');
  for (const sheet of res.data.sheets || []) {
    const props = sheet.properties;
    console.log(`- [${props?.title}] ID: ${props?.sheetId} | Grid: ${props?.gridProperties?.rowCount} rows x ${props?.gridProperties?.columnCount} cols`);
  }
}

inspectTabs().catch(console.error);
