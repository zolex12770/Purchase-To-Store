import { google } from 'googleapis';
import { GoogleAuth } from 'google-auth-library';
import { env } from '../config/env.js';

async function main() {
  const auth = new GoogleAuth({
    keyFile: env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  console.log('Fetching Requisition tab from source spreadsheet...');
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: env.GOOGLE_SHEET_ID,
    range: "'Requisition'!A1:R",
    valueRenderOption: 'FORMATTED_VALUE',
  });
  const rows = res.data.values || [];
  console.log('Total rows:', rows.length);
  const headers = rows[0] || [];
  console.log('Headers:', headers);

  const dateFreq: Record<string, number> = {};
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const d = (r[1] || '').trim();
    dateFreq[d] = (dateFreq[d] || 0) + 1;
  }

  // Find any dates containing '13', 'Oct', '10', '26', '36'
  const allDateKeys = Object.keys(dateFreq);
  console.log('Total distinct date strings:', allDateKeys.length);

  const octKeys = allDateKeys.filter((k) => /oct/i.test(k));
  console.log('Keys matching /oct/i:', octKeys.map((k) => `${k} (${dateFreq[k]} rows)`));

  const day13Keys = allDateKeys.filter((k) => /(^0?13[-/]|[-/]0?13[-/]|[-/]0?13$|^13-)/i.test(k));
  console.log('Keys with 13:', day13Keys.map((k) => `${k} (${dateFreq[k]} rows)`));

  const year36Keys = allDateKeys.filter((k) => /36/i.test(k));
  console.log('Keys with 36:', year36Keys.map((k) => `${k} (${dateFreq[k]} rows)`));

  // Also inspect UNFORMATTED_VALUE to see raw serial numbers or actual values
  const rawRes = await sheets.spreadsheets.values.get({
    spreadsheetId: env.GOOGLE_SHEET_ID,
    range: "'Requisition'!A1:R",
    valueRenderOption: 'UNFORMATTED_VALUE',
  });
  const rawRows = rawRes.data.values || [];
  const rawDateFreq: Record<string, number> = {};
  for (let i = 1; i < rawRows.length; i++) {
    const r = rawRows[i];
    const d = String(r[1] ?? '').trim();
    rawDateFreq[d] = (rawDateFreq[d] || 0) + 1;
  }
  const rawKeys = Object.keys(rawDateFreq);
  console.log('Raw unformatted date keys sample (first 20):', rawKeys.slice(0, 20));
}

main().catch(console.error);
