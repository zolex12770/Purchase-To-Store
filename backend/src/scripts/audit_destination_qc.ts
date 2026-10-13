import { google } from 'googleapis';
import { GoogleAuth } from 'google-auth-library';
import { env } from '../config/env.js';

async function checkDestinationQcRequired() {
  const auth = new GoogleAuth({
    keyFile: env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const sheets = google.sheets({ version: 'v4', auth });
  const destId = env.GOOGLE_DB_SPREADSHEET_ID;

  console.log('--- INSPECTING DESTINATION QC REQUIRED COLUMN ---');
  console.log('Destination ID:', destId);

  // Read header row
  const headerRes = await sheets.spreadsheets.values.get({
    spreadsheetId: destId,
    range: `'Item Master'!1:1`,
  });
  const headers = headerRes.data.values?.[0] || [];
  console.log('Destination Headers count:', headers.length);
  const qcColIdx = headers.findIndex((h) => /qc.*required/i.test(h));
  console.log(`QC Required column index: ${qcColIdx} (Header: "${headers[qcColIdx]}")`);

  // Read all rows of Item Master
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: destId,
    range: `'Item Master'!A1:O`,
  });
  const rows = res.data.values || [];
  console.log('Total populated rows in Item Master:', rows.length);

  const counts: Record<string, number> = {};
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i] || [];
    const itemCode = row[0] || '';
    if (!itemCode.trim()) continue;

    const val = (row[qcColIdx] || '').trim();
    counts[val || '<EMPTY>'] = (counts[val || '<EMPTY>'] || 0) + 1;
  }

  console.log('QC Required distribution across destination items:', JSON.stringify(counts, null, 2));
}

checkDestinationQcRequired().catch(console.error);
