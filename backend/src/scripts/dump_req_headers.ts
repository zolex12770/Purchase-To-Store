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
  const res = await apiRequest('/requisitions?pageSize=50&sortBy=createdAt&sortDir=desc', token);
  const rows = res.data || [];
  console.log(`Last 50 Requisitions in DB (Total: ${res.meta?.total}):`);
  for (const r of rows) {
    console.log(`ID: ${r.id} | ReqNo: ${r.requisition_no} | Date: ${r.requisition_date} | User: ${r.employee_name} | Lines: ${r.line_count} | Items: ${r.item_codes}`);
  }
}

main().catch(console.error);
