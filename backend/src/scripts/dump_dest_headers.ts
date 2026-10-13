import { google } from 'googleapis';
import { GoogleAuth } from 'google-auth-library';
import { env } from '../config/env.js';

async function dumpHeaders() {
  const auth = new GoogleAuth({
    keyFile: env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const sheets = google.sheets({ version: 'v4', auth });
  const destId = env.GOOGLE_DB_SPREADSHEET_ID;

  const meta = await sheets.spreadsheets.get({ spreadsheetId: destId });
  for (const s of meta.data.sheets || []) {
    const title = s.properties?.title;
    if (!title) continue;
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: destId,
      range: `'${title.replace(/'/g, "''")}'!1:1`,
    });
    const header = res.data.values?.[0] || [];
    console.log(`=== TAB: [${title}] === (${header.length} columns)`);
    console.log(JSON.stringify(header));
    console.log('');
  }
}

dumpHeaders();
