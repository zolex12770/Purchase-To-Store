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

  // Let's get top 30 requisitions sorted by id DESC
  const res = await apiRequest('/requisitions?pageSize=40&sortBy=createdAt&sortDir=desc', 'GET', null, token);
  const rows = res.data.data || [];
  console.log('Top 40 requisitions by creation:');
  for (const r of rows) {
    const d = await apiRequest(`/requisitions/${r.id}`, 'GET', null, token);
    const detail = d.data.data;
    const items = detail.lines?.map((l: any) => `${l.item_code} (qty: ${l.requested_qty})`).join(', ');
    console.log(`ID ${r.id}: No=${r.requisition_no}, Date=${String(r.requisition_date).slice(0, 10)}, Emp=${r.employee_name}, Dept=${r.department_name}, Items=[${items}]`);
  }
}

main().catch(console.error);
