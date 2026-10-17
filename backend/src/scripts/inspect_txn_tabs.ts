import { google } from 'googleapis';
import { GoogleAuth } from 'google-auth-library';
import { requireGoogleKeyFile } from '../config/google.js';

const TABS_TO_INSPECT = [
  { cat: 'RM', sheetId: '1smKiS3li81F7aH2pQ0JGgDLp7302d48FJkvWefRf8R4', tab: 'GRN Inward' },
  { cat: 'RM', sheetId: '1smKiS3li81F7aH2pQ0JGgDLp7302d48FJkvWefRf8R4', tab: 'RM Outward' },
  { cat: 'RM', sheetId: '1smKiS3li81F7aH2pQ0JGgDLp7302d48FJkvWefRf8R4', tab: 'Production Inward' },
  { cat: 'FG', sheetId: '1mA5il8Jqjgal9g20o-UzqQGv3y-mgPHpjl9KU-XomyQ', tab: 'Inward FG ' },
  { cat: 'FG', sheetId: '1mA5il8Jqjgal9g20o-UzqQGv3y-mgPHpjl9KU-XomyQ', tab: 'Outward FG' },
  { cat: 'TRADING', sheetId: '14AHr2aSmpcCxfNhcWnjGU1DVE-BfJpLOWrnFn3bkilk', tab: 'Inward Trading' },
  { cat: 'TRADING', sheetId: '14AHr2aSmpcCxfNhcWnjGU1DVE-BfJpLOWrnFn3bkilk', tab: 'Outward Trading ' },
  { cat: 'WIP', sheetId: '1BirIwXOG4F604q5n1UY0r6kjet4mTdmbhC9FDbTrUXs', tab: 'Inward WIP' },
  { cat: 'WIP', sheetId: '1BirIwXOG4F604q5n1UY0r6kjet4mTdmbhC9FDbTrUXs', tab: 'Outward WIP' },
  { cat: 'GENERAL', sheetId: '1VnpDk6kBK2xUGJTVB1CCqlG105UX0_Gs0aAv-bnMpKY', tab: 'GRN Register (Store Inward Entry)' },
  { cat: 'GENERAL', sheetId: '1VnpDk6kBK2xUGJTVB1CCqlG105UX0_Gs0aAv-bnMpKY', tab: 'Issue Register (Store Outward Entry)' },
];

async function inspectTxnTabs() {
  const auth = new GoogleAuth({
    keyFile: requireGoogleKeyFile('Nothing was read.'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const sheets = google.sheets({ version: 'v4', auth: auth as never });

  for (const t of TABS_TO_INSPECT) {
    console.log(`\n======================================================`);
    console.log(`TAB: [${t.cat}] "${t.tab}"`);
    try {
      const res = await sheets.spreadsheets.values.get({
        spreadsheetId: t.sheetId,
        range: `'${t.tab}'!A1:Z6`,
        valueRenderOption: 'FORMATTED_VALUE',
      });
      const rows = res.data.values || [];
      console.log(`Rows returned: ${rows.length}`);
      for (let i = 0; i < rows.length; i++) {
        console.log(`  Row ${i + 1}:`, JSON.stringify(rows[i].slice(0, 10)));
      }
    } catch (err: any) {
      console.error(`  Error reading "${t.tab}":`, err.message);
    }
  }
}

inspectTxnTabs().catch(console.error);
