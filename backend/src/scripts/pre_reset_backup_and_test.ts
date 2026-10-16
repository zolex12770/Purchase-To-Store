import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { restoreFromPayload, type BackupPayload } from '../db/restore.js';
import { scriptApiTarget, scriptCredentials } from './script-target.js';

// Target and account come from the environment; production needs ZOLEX_ALLOW_PRODUCTION=yes.
const SCRIPT_API = scriptApiTarget();
const SCRIPT_LOGIN = scriptCredentials();

function request(options: http.RequestOptions, body?: unknown): Promise<{ status: number; headers: http.IncomingHttpHeaders; data: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode ?? 0, headers: res.headers, data: JSON.parse(d) });
        } catch {
          resolve({ status: res.statusCode ?? 0, headers: res.headers, data: d });
        }
      });
    });
    req.on('error', reject);
    if (body) {
      req.write(typeof body === 'string' ? body : JSON.stringify(body));
    }
    req.end();
  });
}

async function main() {
  console.log('=== PHASE 2: BACKUP & RESTORE INTEGRITY GATE ===');

  // 1. Sign in (as the account in ZOLEX_SCRIPT_EMPLOYEE_ID; it needs sync.admin and backup.create)
  const login = await request(
    { hostname: SCRIPT_API.hostname, port: SCRIPT_API.port, path: '/api/v1/auth/login', method: 'POST', headers: { 'Content-Type': 'application/json' } },
    SCRIPT_LOGIN,
  );
  if (!login.data?.success) {
    throw new Error('Failed to sign in: ' + JSON.stringify(login.data));
  }
  const token = login.data.data.accessToken;
  const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
  console.log('1. Authenticated as:', login.data.data.user.employeeName);

  // 2. Fence sync: set Live Sync OFF
  const toggleRes = await request(
    { hostname: SCRIPT_API.hostname, port: SCRIPT_API.port, path: '/api/v1/google-sync/toggle', method: 'POST', headers },
    { enabled: false },
  );
  console.log('2. Fenced Google Sheets Sync (OFF):', toggleRes.data?.data?.message || toggleRes.data);

  // 3. Create full database backup
  const backupRes = await request(
    { hostname: SCRIPT_API.hostname, port: SCRIPT_API.port, path: '/api/v1/backup', method: 'POST', headers },
    { notes: 'Pre-reset master backup before live Google Sheets re-import' },
  );
  if (backupRes.status !== 201) {
    throw new Error('Backup creation failed: ' + JSON.stringify(backupRes.data));
  }
  const backupMeta = backupRes.data.data;
  const filePath = path.join(backupMeta.location, backupMeta.filename);
  console.log('3. Created official backup:');
  console.log('   Filename:', backupMeta.filename);
  console.log('   File Path:', filePath);
  console.log('   Size:', backupMeta.sizeBytes, 'bytes');
  console.log('   Checksum (SHA-256):', backupMeta.checksum);
  console.log('   Table Counts:', JSON.stringify(backupMeta.tableCounts));

  // 4. Verify physical backup file existence and checksum
  const backupRaw = fs.readFileSync(filePath, 'utf8');
  const actualHash = crypto.createHash('sha256').update(backupRaw).digest('hex');
  if (actualHash !== backupMeta.checksum) {
    throw new Error(`Integrity Check Failed: Expected ${backupMeta.checksum}, got ${actualHash}`);
  }
  console.log('4. Integrity Check: VERIFIED (Checksum matches physical file on disk)');

  // 5. Perform ISOLATED RESTORE TEST in a temporary PGlite database
  console.log('\n--- 5. PERFORMING ISOLATED RESTORE TEST ---');
  const tempDbDir = path.join(process.cwd(), 'tmp', 'test-restore-' + Date.now());
  fs.mkdirSync(tempDbDir, { recursive: true });
  console.log('   Creating temporary test PGlite database at:', tempDbDir);

  const testDb = new PGlite(tempDbDir);
  await testDb.waitReady;

  // Run all migrations in test database so schema exists
  const migrationsDir = path.join(process.cwd(), 'dist', 'db', 'migrations');
  const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
  await testDb.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version VARCHAR(50) PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  for (const f of files) {
    const sql = fs.readFileSync(path.join(migrationsDir, f), 'utf8');
    await testDb.exec(sql);
    await testDb.query('INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT DO NOTHING', [f]);
  }
  console.log(`   Applied ${files.length} migrations to temporary test database.`);

  // Restore from payload
  const payload: BackupPayload = JSON.parse(backupRaw);
  const restoreResult = await restoreFromPayload(testDb, payload);
  console.log('   Restore executed. Restored table counts:');
  console.log('  ', JSON.stringify(restoreResult));

  // Verify rows match original counts
  let allMatched = true;
  for (const [tbl, expectedCount] of Object.entries(backupMeta.tableCounts)) {
    const actual = restoreResult.restored[tbl] ?? 0;
    if (actual !== expectedCount) {
      console.error(`   MISMATCH in ${tbl}: expected ${expectedCount}, got ${actual}`);
      allMatched = false;
    }
  }

  await testDb.close();
  // Clean up temp test directory
  fs.rmSync(tempDbDir, { recursive: true, force: true });

  if (!allMatched) {
    throw new Error('Restore Test FAILED: Some table row counts did not match backup metadata!');
  }
  console.log('   Restore Test: PASSED! (All restored tables matched 100% of backup row counts)');
  console.log('\nBackup and restore safety gate successfully passed.');
}

main().catch(console.error);
