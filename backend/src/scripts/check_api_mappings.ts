import http from 'node:http';
import { scriptApiTarget, scriptCredentials } from './script-target.js';

// Target and account come from the environment; production needs ZOLEX_ALLOW_PRODUCTION=yes.
const SCRIPT_API = scriptApiTarget();
const SCRIPT_LOGIN = scriptCredentials();

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
    { hostname: SCRIPT_API.hostname, port: SCRIPT_API.port, path: '/api/v1/auth/login', method: 'POST', headers: { 'Content-Type': 'application/json' } },
    SCRIPT_LOGIN
  );
  const token = login.data?.accessToken;
  const sync = await request(
    { hostname: SCRIPT_API.hostname, port: SCRIPT_API.port, path: '/api/v1/google-sync/status', method: 'GET', headers: { Authorization: `Bearer ${token}` } }
  );
  console.log('Login result:', login.success, login.data?.user?.employeeName);
  console.log('Sync result:', sync);
}

main().catch(console.error);
