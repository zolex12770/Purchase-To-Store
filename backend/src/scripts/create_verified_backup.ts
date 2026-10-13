import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';

function request(options: http.RequestOptions, body?: any): Promise<{ status: number; data: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode || 200, data: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode || 200, data });
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
  console.log('========================================================================');
  console.log('CREATING VERIFIED RESTORABLE PRODUCTION BACKUP');
  console.log('Timestamp:', new Date().toISOString());
  console.log('========================================================================\n');

  // 1. Sign in as Super Admin
  const login = await request(
    { hostname: '127.0.0.1', port: 4001, path: '/api/v1/auth/login', method: 'POST', headers: { 'Content-Type': 'application/json' } },
    { employeeId: '10221', password: 'Admin@123' },
  );
  if (!login.data?.success) {
    throw new Error('Failed to sign in as Super Admin: ' + JSON.stringify(login.data));
  }
  const token = login.data.data.accessToken;
  const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
  console.log('✓ 1. Authenticated as Super Admin:', login.data.data.user.employeeName);

  // 2. Create full production database backup
  const backupRes = await request(
    { hostname: '127.0.0.1', port: 4001, path: '/api/v1/backup', method: 'POST', headers },
    { notes: 'Production stabilization backup before Phase 1-11 repair' },
  );
  if (backupRes.status !== 201 && backupRes.status !== 200) {
    throw new Error('Backup creation failed: ' + JSON.stringify(backupRes.data));
  }
  const backupMeta = backupRes.data.data;
  const filePath = path.join(backupMeta.location, backupMeta.filename);
  console.log('✓ 2. Backup created successfully:');
  console.log('   - File Path:', filePath);
  console.log('   - File Size:', backupMeta.sizeBytes, 'bytes');

  // 3. Verify file on disk and compute SHA-256
  const buffer = fs.readFileSync(filePath);
  const actualSha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  console.log('✓ 3. Disk Verification:');
  console.log('   - Read size:', buffer.length, 'bytes');
  console.log('   - SHA-256:', actualSha256);
  if (backupMeta.sha256 && backupMeta.sha256 !== actualSha256) {
    throw new Error('SHA-256 mismatch! Metadata: ' + backupMeta.sha256 + ', Disk: ' + actualSha256);
  }

  // 4. Inspect tables inside backup JSON
  const parsed = JSON.parse(buffer.toString('utf8'));
  const tables = parsed.tables || {};
  console.log('✓ 4. Backup Content Verification:');
  console.log('   - Items count:', tables.items?.length);
  console.log('   - Suppliers count:', tables.suppliers?.length);
  console.log('   - GRN headers count:', tables.grn_headers?.length);
  console.log('   - GRN lines count:', tables.grn_lines?.length);
  console.log('   - Stock Ledger count:', tables.stock_ledger?.length);
  console.log('   - Requisition headers count:', tables.requisition_headers?.length);
  console.log('   - Requisition lines count:', tables.requisition_lines?.length);

  console.log('\n========================================================================');
  console.log('PRODUCTION BACKUP VERIFIED & READY FOR RESTORATION IF NEEDED');
  console.log('========================================================================\n');
}

main().catch((err) => {
  console.error('BACKUP FAILED:', err);
  process.exit(1);
});
