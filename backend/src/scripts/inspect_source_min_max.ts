import { google } from 'googleapis';
import { GoogleAuth } from 'google-auth-library';
import { env } from '../config/env.js';

async function inspectMinMax() {
  const auth = new GoogleAuth({
    keyFile: env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const sheets = google.sheets({ version: 'v4', auth });
  const sourceId = env.GOOGLE_SHEET_ID;

  console.log('--- INSPECTING SOURCE ITEM MASTER HEADERS & MIN/MAX ---');
  console.log('Source Sheet ID:', sourceId);

  // Read header row (row 1)
  const headerRes = await sheets.spreadsheets.values.get({
    spreadsheetId: sourceId,
    range: `'Item Master'!1:1`,
  });
  const headers = headerRes.data.values?.[0] || [];
  console.log(`Total Headers count: ${headers.length}`);
  headers.forEach((h, idx) => {
    const colLetter = String.fromCharCode(65 + idx);
    console.log(`  Col ${colLetter} (index ${idx}): "${h}"`);
  });

  // Read first 20 rows of columns A to Z
  const dataRes = await sheets.spreadsheets.values.get({
    spreadsheetId: sourceId,
    range: `'Item Master'!A1:Z25`,
  });
  const rows = dataRes.data.values || [];
  console.log(`\nSample rows count: ${rows.length}`);
  for (let i = 1; i <= Math.min(10, rows.length - 1); i++) {
    const r = rows[i] || [];
    console.log(`Row ${i + 1}: Code="${r[0]}" | Name="${r[1]}" | Col P (idx 15)="${r[15] ?? ''}" | Col Q (idx 16)="${r[16] ?? ''}"`);
  }

  // Count non-empty Min and Max values across all rows in source
  const fullRes = await sheets.spreadsheets.values.get({
    spreadsheetId: sourceId,
    range: `'Item Master'!A1:Q`,
  });
  const fullRows = fullRes.data.values || [];
  console.log(`\nTotal rows in Item Master: ${fullRows.length}`);

  let minPopulated = 0;
  let maxPopulated = 0;
  const samples: any[] = [];
  for (let i = 1; i < fullRows.length; i++) {
    const r = fullRows[i] || [];
    const minVal = r[15];
    const maxVal = r[16];
    if (minVal !== undefined && String(minVal).trim() !== '') minPopulated++;
    if (maxVal !== undefined && String(maxVal).trim() !== '') maxPopulated++;
    if ((minVal !== undefined && String(minVal).trim() !== '') || (maxVal !== undefined && String(maxVal).trim() !== '')) {
      if (samples.length < 5) {
        samples.push({ row: i + 1, code: r[0], min: minVal, max: maxVal });
      }
    }
  }

  console.log(`Min populated count: ${minPopulated}`);
  console.log(`Max populated count: ${maxPopulated}`);
  if (samples.length > 0) {
    console.log('Samples with Min/Max:', JSON.stringify(samples, null, 2));
  }
}

inspectMinMax().catch(console.error);
