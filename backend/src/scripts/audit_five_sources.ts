import { google } from 'googleapis';
import { GoogleAuth } from 'google-auth-library';
import { requireGoogleKeyFile } from '../config/google.js';

interface SheetAuditSummary {
  category: string;
  spreadsheetId: string;
  tabs: Array<{ title: string; rowCount: number; colCount: number }>;
  stockTab: string;
  headerRows: any[][];
  sampleDataRows: any[][];
  totalSourceRows: number;
  nonEmptyCodesCount: number;
  blankCodesCount: number;
  duplicateCodesCount: number;
  negativeQtyCount: number;
  totalQtySum: number;
  totalWeightSum: number;
  uomValues: string[];
}

const SOURCES = [
  {
    category: 'RM',
    spreadsheetId: '1smKiS3li81F7aH2pQ0JGgDLp7302d48FJkvWefRf8R4',
    expectedStockTab: 'RM Stock Live',
    range: "'RM Stock Live'!A1:Z1000",
  },
  {
    category: 'FG',
    spreadsheetId: '1mA5il8Jqjgal9g20o-UzqQGv3y-mgPHpjl9KU-XomyQ',
    expectedStockTab: 'FG  Stock Live',
    range: "'FG  Stock Live'!A1:Z5000",
  },
  {
    category: 'TRADING',
    spreadsheetId: '14AHr2aSmpcCxfNhcWnjGU1DVE-BfJpLOWrnFn3bkilk',
    expectedStockTab: 'Trading Live Stock',
    range: "'Trading Live Stock'!A1:Z500",
  },
  {
    category: 'WIP',
    spreadsheetId: '1BirIwXOG4F604q5n1UY0r6kjet4mTdmbhC9FDbTrUXs',
    expectedStockTab: 'WIP  Stock Live',
    range: "'WIP  Stock Live'!A1:Z1000",
  },
  {
    category: 'GENERAL',
    spreadsheetId: '1VnpDk6kBK2xUGJTVB1CCqlG105UX0_Gs0aAv-bnMpKY',
    expectedStockTab: 'General Item Live Stock',
    range: "'General Item Live Stock'!A1:Z5000",
  },
];

async function run() {
  const auth = new GoogleAuth({
    keyFile: requireGoogleKeyFile('Nothing was read.'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const sheets = google.sheets({ version: 'v4', auth: auth as never });

  console.log('=== AUDITING ALL 5 GOOGLE SHEETS ===\n');

  for (const src of SOURCES) {
    console.log(`--------------------------------------------------------------------------------`);
    console.log(`CATEGORY: ${src.category}`);
    console.log(`SPREADSHEET ID: ${src.spreadsheetId}`);

    try {
      // 1. Get spreadsheet metadata (all tabs)
      const meta = await sheets.spreadsheets.get({
        spreadsheetId: src.spreadsheetId,
      });

      console.log('TABS FOUND:');
      const tabs = (meta.data.sheets || []).map((s) => ({
        title: s.properties?.title || '',
        rowCount: s.properties?.gridProperties?.rowCount || 0,
        colCount: s.properties?.gridProperties?.columnCount || 0,
      }));
      for (const t of tabs) {
        console.log(`  - "${t.title}" (${t.rowCount} rows x ${t.colCount} cols)`);
      }

      // 2. Read headers & data from the stock tab
      const tabToUse = tabs.find((t) => t.title.trim().toLowerCase() === src.expectedStockTab.trim().toLowerCase())?.title || src.expectedStockTab;
      
      const res = await sheets.spreadsheets.values.get({
        spreadsheetId: src.spreadsheetId,
        range: `'${tabToUse}'!A1:Z`,
        valueRenderOption: 'FORMATTED_VALUE',
      });

      const allRows = res.data.values || [];
      console.log(`Total raw rows in "${tabToUse}": ${allRows.length}`);

      // Print first 12 rows to see where header is and where data starts
      console.log('FIRST 12 ROWS:');
      for (let r = 0; r < Math.min(12, allRows.length); r++) {
        console.log(`  Row ${r + 1}: ${JSON.stringify(allRows[r].slice(0, 14))}`);
      }
    } catch (err: any) {
      console.error(`ERROR auditing ${src.category}:`, err.message);
    }
  }
}

run().catch(console.error);
