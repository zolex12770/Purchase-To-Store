import { google } from 'googleapis';
import { GoogleAuth } from 'google-auth-library';
import { env } from '../config/env.js';

async function countDestRows() {
  const auth = new GoogleAuth({
    keyFile: env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const sheets = google.sheets({ version: 'v4', auth });
  const destId = env.GOOGLE_DB_SPREADSHEET_ID;

  const meta = await sheets.spreadsheets.get({ spreadsheetId: destId });
  console.log('--- EXACT POPULATED ROW COUNTS IN DESTINATION SPREADSHEET ---');
  for (const s of meta.data.sheets || []) {
    const title = s.properties?.title;
    if (!title) continue;
    // Get all column A values to count populated rows accurately
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: destId,
      range: `'${title.replace(/'/g, "''")}'!A:A`,
    });
    const totalA = res.data.values?.length || 0;
    const dataRows = Math.max(0, totalA - 1);
    console.log(`Tab [${title.padEnd(25)}]: Total rows: ${totalA}, Header: 1, Data rows: ${dataRows}`);
  }
}

countDestRows();
