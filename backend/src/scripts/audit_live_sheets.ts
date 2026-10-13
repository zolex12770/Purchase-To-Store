import { env } from '../config/env.js';
import { google } from 'googleapis';
import { GoogleAuth } from 'google-auth-library';

async function main() {
  const auth = new GoogleAuth({
    keyFile: env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  console.log('Connecting to Google Sheet:', env.GOOGLE_SHEET_ID);
  const meta = await sheets.spreadsheets.get({ spreadsheetId: env.GOOGLE_SHEET_ID });

  console.log('Spreadsheet Title:', meta.data.properties?.title);
  console.log('Spreadsheet TimeZone:', meta.data.properties?.timeZone);
  console.log('\n--- TAB METADATA ---');
  for (const s of meta.data.sheets ?? []) {
    console.log(JSON.stringify({
      title: s.properties?.title,
      sheetId: s.properties?.sheetId,
      rowCount: s.properties?.gridProperties?.rowCount,
      columnCount: s.properties?.gridProperties?.columnCount,
    }));
  }

  console.log('\n--- FETCHING SAMPLE ROWS 1070-1092 IN Item Master ---');
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: env.GOOGLE_SHEET_ID,
    range: "'Item Master'!A1070:E1092",
    valueRenderOption: 'FORMATTED_VALUE',
  });
  for (let i = 0; i < (res.data.values ?? []).length; i++) {
    console.log(`Row ${1070 + i}:`, JSON.stringify(res.data.values?.[i]));
  }

  console.log('\n--- FETCHING RAW FORMULA VALUES 1070-1092 IN Item Master ---');
  const resFormula = await sheets.spreadsheets.values.get({
    spreadsheetId: env.GOOGLE_SHEET_ID,
    range: "'Item Master'!A1070:E1092",
    valueRenderOption: 'FORMULA',
  });
  for (let i = 0; i < (resFormula.data.values ?? []).length; i++) {
    console.log(`Row ${1070 + i} Formula:`, JSON.stringify(resFormula.data.values?.[i]));
  }
}

main().catch(console.error);
