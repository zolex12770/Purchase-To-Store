import { google } from 'googleapis';
import { GoogleAuth } from 'google-auth-library';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { env, paths } from '../config/env.js';

export async function backupDestinationSheet(): Promise<{ backupPath: string; checksum: string; size: number }> {
  const auth = new GoogleAuth({
    keyFile: env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const sheets = google.sheets({ version: 'v4', auth });
  const destId = env.GOOGLE_DB_SPREADSHEET_ID;

  console.log('=== STARTING DESTINATION SPREADSHEET BACKUP ===');
  console.log('Spreadsheet ID:', destId);

  const meta = await sheets.spreadsheets.get({ spreadsheetId: destId });
  const backupData: {
    spreadsheetId: string;
    title: string;
    backedUpAt: string;
    sheets: Array<{
      title: string;
      sheetId: number;
      gridProperties: any;
      values: any[][];
    }>;
  } = {
    spreadsheetId: destId,
    title: meta.data.properties?.title || 'Purchase Module Database',
    backedUpAt: new Date().toISOString(),
    sheets: [],
  };

  for (const s of meta.data.sheets || []) {
    const title = s.properties?.title || '';
    const sheetId = s.properties?.sheetId || 0;
    const gridProperties = s.properties?.gridProperties || {};

    console.log(`Backing up tab [${title}]...`);
    const valRes = await sheets.spreadsheets.values.get({
      spreadsheetId: destId,
      range: `'${title.replace(/'/g, "''")}'!A1:ZZ`,
      valueRenderOption: 'UNFORMATTED_VALUE',
    });
    const values = valRes.data.values || [];
    console.log(`  ✓ Read ${values.length} rows`);

    backupData.sheets.push({
      title,
      sheetId,
      gridProperties,
      values,
    });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = paths.backups;
  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
  }

  const backupPath = path.join(backupDir, `destination-backup-${timestamp}.json`);
  const jsonStr = JSON.stringify(backupData, null, 2);
  fs.writeFileSync(backupPath, jsonStr, 'utf8');

  const size = Buffer.byteLength(jsonStr, 'utf8');
  const checksum = crypto.createHash('sha256').update(jsonStr).digest('hex');

  console.log('================================================');
  console.log('DESTINATION SPREADSHEET BACKUP COMPLETED!');
  console.log('Backup Path:', backupPath);
  console.log('Size:', size, 'bytes');
  console.log('SHA-256 Checksum:', checksum);
  console.log('================================================');

  return { backupPath, checksum, size };
}

if (process.argv[1]?.endsWith('backup_destination_sheet.ts') || process.argv[1]?.endsWith('backup_destination_sheet.js')) {
  backupDestinationSheet()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('BACKUP FAILED:', err);
      process.exit(1);
    });
}
