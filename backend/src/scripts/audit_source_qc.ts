import { google } from 'googleapis';
import { GoogleAuth } from 'google-auth-library';
import { env } from '../config/env.js';

async function checkQcRequired() {
  const auth = new GoogleAuth({
    keyFile: env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const sheets = google.sheets({ version: 'v4', auth });
  const sourceId = env.GOOGLE_SHEET_ID;

  console.log('--- INSPECTING SOURCE QC REQUIRED COLUMN ---');
  console.log('Source ID:', sourceId);

  // Read header row first to identify exact column index
  const headerRes = await sheets.spreadsheets.values.get({
    spreadsheetId: sourceId,
    range: `'Item Master'!1:1`,
  });
  const headers = headerRes.data.values?.[0] || [];
  console.log('Source Headers count:', headers.length);
  const qcColIdx = headers.findIndex((h) => /qc.*required/i.test(h));
  console.log(`QC Required column index: ${qcColIdx} (Header: "${headers[qcColIdx]}")`);

  // Read all rows of Item Master
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: sourceId,
    range: `'Item Master'!A1:O`,
  });
  const rows = res.data.values || [];
  console.log('Total populated rows in Item Master:', rows.length);

  const counts: Record<string, number> = {};
  const samplesWithValues: Array<{ row: number; itemCode: string; val: string }> = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i] || [];
    const itemCode = row[0] || '';
    if (!itemCode.trim()) continue;

    const val = (row[qcColIdx] || '').trim();
    counts[val || '<EMPTY>'] = (counts[val || '<EMPTY>'] || 0) + 1;
    if (val) {
      samplesWithValues.push({ row: i + 1, itemCode, val });
    }
  }

  console.log('QC Required distribution across populated items:', JSON.stringify(counts, null, 2));
  console.log(`Populated non-empty values count: ${samplesWithValues.length}`);
  if (samplesWithValues.length > 0) {
    console.log('Sample non-empty values:', JSON.stringify(samplesWithValues.slice(0, 5), null, 2));
  }
}

checkQcRequired();
