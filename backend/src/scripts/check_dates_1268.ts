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
  const d1268 = await apiRequest('/requisitions/1268', token);
  console.log('ID 1268 (RN-1155):', JSON.stringify({
    requisition_no: d1268.data.requisition_no,
    requisition_date: d1268.data.requisition_date,
    created_at: d1268.data.created_at,
    lines: d1268.data.lines?.map((l: any) => ({ line_no: l.line_no, item_code: l.item_code, requested_qty: l.requested_qty })),
  }, null, 2));

  const d1269 = await apiRequest('/requisitions/1269', token);
  console.log('ID 1269 (RN-1157):', JSON.stringify({
    requisition_no: d1269.data.requisition_no,
    requisition_date: d1269.data.requisition_date,
    created_at: d1269.data.created_at,
    lines: d1269.data.lines?.map((l: any) => ({ line_no: l.line_no, item_code: l.item_code, requested_qty: l.requested_qty })),
  }, null, 2));
}

main().catch(console.error);
