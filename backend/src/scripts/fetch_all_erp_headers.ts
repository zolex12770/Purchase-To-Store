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

  let page = 1;
  const allHeaders: any[] = [];
  while (true) {
    const res = await apiRequest(`/requisitions?page=${page}&pageSize=200`, 'GET', null, token);
    if (!res.data.success) {
      console.error('API Error:', res.data);
      break;
    }
    const rows = res.data.data || [];
    allHeaders.push(...rows);
    if (page >= (res.data.meta?.totalPages || 1) || rows.length === 0) break;
    page++;
  }

  console.log(`Successfully fetched ${allHeaders.length} ERP requisition headers!`);

  // How many have requisition_date = 2026-10-13?
  const oct13 = allHeaders.filter((h) => String(h.requisition_date || '').slice(0, 10) === '2026-10-13');
  console.log(`Requisitions with date 2026-10-13 in ERP: ${oct13.length}`);
  for (const h of oct13) {
    console.log(`  ID ${h.id}: No=${h.requisition_no}, Emp=${h.employee_name}, Dept=${h.department_name}, Lines=${h.line_count}`);
  }
}

main().catch(console.error);
