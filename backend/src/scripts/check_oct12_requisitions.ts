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
  const res = await apiRequest('/requisitions?dateFrom=2026-10-12&dateTo=2026-10-12&pageSize=100', token);
  const rows = res.data || [];
  console.log(`Requisitions in ERP for 2026-10-12: Total ${res.meta?.total ?? rows.length}`);
  for (const r of rows) {
    console.log(`  ID: ${r.id}, No: ${r.requisition_no}, Date: ${r.requisition_date}, Lines: ${r.line_count}, Items: ${r.item_codes}`);
  }
}

main().catch(console.error);
