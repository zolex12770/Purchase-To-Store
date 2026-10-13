import { google } from 'googleapis';
import { GoogleAuth } from 'google-auth-library';
import { env } from '../config/env.js';

async function trimGrids() {
  const auth = new GoogleAuth({
    keyFile: env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });
  const destId = env.GOOGLE_DB_SPREADSHEET_ID;

  console.log('--- TRIMMING GHOST ROWS FROM DESTINATION GRID ---');
  console.log('Destination ID:', destId);

  // Set Item Master rowCount to 3250 (sheetId: 1643190240)
  // Set Supplier Master rowCount to 1500 (sheetId: 1700700767)
  const requests = [
    {
      updateSheetProperties: {
        properties: {
          sheetId: 1643190240,
          gridProperties: {
            rowCount: 3250,
          },
        },
        fields: 'gridProperties.rowCount',
      },
    },
    {
      updateSheetProperties: {
        properties: {
          sheetId: 1700700767,
          gridProperties: {
            rowCount: 1500,
          },
        },
        fields: 'gridProperties.rowCount',
      },
    },
  ];

  const res = await sheets.spreadsheets.batchUpdate({
    spreadsheetId: destId,
    requestBody: { requests },
  });

  console.log('✓ Successfully trimmed destination grids!');
  console.log('Replies:', res.data.replies?.length);
}

trimGrids().catch(console.error);
