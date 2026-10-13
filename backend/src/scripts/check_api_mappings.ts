import http from 'node:http';

function request(options: http.RequestOptions, body?: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve(data);
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function main() {
  const login = await request(
    { hostname: '127.0.0.1', port: 4001, path: '/api/v1/auth/login', method: 'POST', headers: { 'Content-Type': 'application/json' } },
    { employeeId: '10221', password: 'Admin@123' }
  );
  const token = login.data?.accessToken;
  const sync = await request(
    { hostname: '127.0.0.1', port: 4001, path: '/api/v1/google-sync/status', method: 'GET', headers: { Authorization: `Bearer ${token}` } }
  );
  console.log('Login result:', login.success, login.data?.user?.employeeName);
  console.log('Sync result:', sync);
}

main().catch(console.error);
