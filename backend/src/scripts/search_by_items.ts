import http from 'node:http';

function apiRequest(endpoint: string, token: string): Promise<any> {
  return new Promise((resolve, reject) => {
    http.get(
      {
        hostname: '127.0.0.1',
        port: 4001,
        path: '/api/v1' + endpoint,
        headers: { Authorization: 'Bearer ' + token },
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => resolve(JSON.parse(raw)));
      },
    ).on('error', reject);
  });
}

async function main() {
  const loginRes = await new Promise<any>((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: 4001,
        path: '/api/v1/auth/login',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => resolve(JSON.parse(raw)));
      },
    );
    req.write(JSON.stringify({ employeeId: '10221', password: 'Admin@123' }));
    req.end();
  });
  const token = loginRes.data.accessToken;

  for (const item of ['ST0085', 'HOK004', 'VBLTB42', 'BGSH140240', 'MIS517']) {
    const res = await apiRequest(`/requisitions?search=${item}&pageSize=10`, token);
    console.log(`Requisitions containing ${item} (total ${res.meta?.total}):`);
    for (const r of (res.data || []).slice(0, 5)) {
      console.log(`  ID ${r.id}: No=${r.requisition_no}, Date=${r.requisition_date}, Items=${r.item_codes}`);
    }
  }
}

main().catch(console.error);
