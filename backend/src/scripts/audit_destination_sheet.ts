import { google } from 'googleapis';
import { GoogleAuth } from 'google-auth-library';
import { env } from '../config/env.js';

async function auditDestination() {
  const destId = env.GOOGLE_DB_SPREADSHEET_ID;
  console.log('--- AUDITING DESTINATION SPREADSHEET ---');
  console.log('Destination ID:', destId);
  console.log('Key file:', env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE);

  const auth = new GoogleAuth({
    keyFile: env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  try {
    const meta = await sheets.spreadsheets.get({
      spreadsheetId: destId,
    });
    console.log('✓ Successfully connected to destination spreadsheet!');
    console.log('Title:', meta.data.properties?.title);
    console.log('Sheets count:', meta.data.sheets?.length);

    console.log('\n--- TAB DETAILS ---');
    for (const s of meta.data.sheets || []) {
      const title = s.properties?.title;
      const sheetId = s.properties?.sheetId;
      const rowCount = s.properties?.gridProperties?.rowCount;
      const colCount = s.properties?.gridProperties?.columnCount;

      // Fetch first 5 rows to see headers and any data
      const dataRes = await sheets.spreadsheets.values.get({
        spreadsheetId: destId,
        range: `'${title}'!A1:Z5`,
      });
      const rows = dataRes.data.values || [];
      const headerRow = rows[0] || [];
      const populatedRows = rows.length;

      console.log(`\nTab: [${title}] (ID: ${sheetId}, Grid: ${rowCount}x${colCount})`);
      console.log(`  Header row (${headerRow.length} cols):`, headerRow.slice(0, 8).join(' | '));
      console.log(`  Populated preview rows: ${populatedRows}`);
      if (rows.length > 1) {
        console.log(`  Sample row 2:`, rows[1]?.slice(0, 8).join(' | '));
      } else {
        console.log(`  ** EMPTY / HEADERS ONLY **`);
      }
    }

    // Now test write capability on a non-destructive cell or test range
    console.log('\n--- TESTING WRITE PERMISSION ---');
    // We can test by reading metadata or writing to a test range if permitted
    // Let's check if there's any tab we can write a test cell to, or test append
    const firstTab = meta.data.sheets?.[0]?.properties?.title;
    if (firstTab) {
      console.log(`Attempting test write on tab '${firstTab}' at cell AZ1...`);
      const writeRes = await sheets.spreadsheets.values.update({
        spreadsheetId: destId,
        range: `'${firstTab}'!AZ1`,
        valueInputOption: 'USER_ENTERED',
        requestBody: {
          values: [['__WRITE_TEST_OK__']],
        },
      });
      console.log('✓ Write successful! Updated cells:', writeRes.data.updatedCells);

      // Read back to prove round-trip verification
      const readBack = await sheets.spreadsheets.values.get({
        spreadsheetId: destId,
        range: `'${firstTab}'!AZ1`,
      });
      console.log('✓ Read-back value:', readBack.data.values?.[0]?.[0]);

      // Clean up AZ1
      await sheets.spreadsheets.values.clear({
        spreadsheetId: destId,
        range: `'${firstTab}'!AZ1`,
      });
      console.log('✓ Cleaned up test cell AZ1');
    }

  } catch (err: any) {
    console.error('ERROR AUDITING DESTINATION SPREADSHEET:', err.message);
    if (err.errors) {
      console.error('Details:', JSON.stringify(err.errors, null, 2));
    }
  }
}

auditDestination();
