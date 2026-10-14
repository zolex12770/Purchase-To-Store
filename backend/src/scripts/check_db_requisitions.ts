import http from 'node:http';

function apiRequest<T = any>(
  endpoint: string,
  method = 'GET',
  body?: any,
  token?: string,
): Promise<{ status: number; data: any }> {
  return new Promise((resolve, reject) => {
    const dataStr = body ? JSON.stringify(body) : undefined;
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: 4001,
        path: `/api/v1${endpoint}`,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(dataStr ? { 'Content-Length': Buffer.byteLength(dataStr) } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode || 200, data: JSON.parse(raw) });
          } catch {
            resolve({ status: res.statusCode || 200, data: raw });
          }
        });
      },
    );
    req.on('error', reject);
    if (dataStr) req.write(dataStr);
    req.end();
  });
}

async function main() {
  const loginRes = await apiRequest('/auth/login', 'POST', { employeeId: '10221', password: 'Admin@123' });
  const token = loginRes.data.data.accessToken;

  // Let's search for RN-1136, RN-1156, RN-1158, RN-1160, RN-1161, RN-1162, RN-1165 in ERP!
  const testNos = ['RN-1136', 'RN-1156', 'RN-1157', 'RN-1158', 'RN-1159', 'RN-1160', 'RN-1161', 'RN-1162', 'RN-1163', 'RN-1164', 'RN-1165', 'RN-1166', 'RN-0723'];
  console.log('Searching for target ReqNos in ERP:');
  for (const no of testNos) {
    const res = await apiRequest(`/requisitions?search=${no}`, 'GET', null, token);
    const rows = res.data.data || [];
    if (rows.length > 0) {
      console.log(`  ${no}: Found ${rows.length} headers! First header: ID=${rows[0].id}, No=${rows[0].requisition_no}, Date=${rows[0].requisition_date}, Status=${rows[0].status}`);
    } else {
      console.log(`  ${no}: NOT FOUND in ERP.`);
    }
  }

  // Check what the highest RN- number in ERP is!
  const allRes = await apiRequest('/requisitions?pageSize=100&sortBy=requisitionNo&sortDir=desc', 'GET', null, token);
  const topRows = allRes.data.data || [];
  console.log('\nTop 15 Requisition numbers in ERP:');
  for (const r of topRows.slice(0, 15)) {
    console.log(`  ID=${r.id}, No=${r.requisition_no}, Date=${r.requisition_date}, Lines=${r.line_count ?? r.lineCount}`);
  }
}

main().catch(console.error);
