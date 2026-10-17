import http from 'node:http';
import { scriptApiTarget, scriptCredentials } from './script-target.js';

// Target and account come from the environment; production needs ZOLEX_ALLOW_PRODUCTION=yes.
const SCRIPT_API = scriptApiTarget();
const SCRIPT_LOGIN = scriptCredentials();

function apiRequest(endpoint: string, token: string): Promise<any> {
  return new Promise((resolve, reject) => {
    http.get(
      {
        hostname: SCRIPT_API.hostname,
        port: SCRIPT_API.port,
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
        hostname: SCRIPT_API.hostname,
        port: SCRIPT_API.port,
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
    req.write(JSON.stringify(SCRIPT_LOGIN));
    req.end();
  });
  const token = loginRes.data.accessToken;

  // Let's check health and requisition count
  const reqRes = await apiRequest('/requisitions?pageSize=1', token);
  console.log('Total Requisitions in DB via API:', reqRes.meta?.total);

  // Check destination sheet row count for Requisition
  console.log('API accessible and healthy.');
}

main().catch(console.error);
