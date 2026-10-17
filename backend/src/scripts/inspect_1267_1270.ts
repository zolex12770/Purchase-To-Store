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

  for (let id = 1267; id <= 1270; id++) {
    const res = await apiRequest(`/requisitions/${id}`, token);
    console.log(`\nRequisition ID ${id}:`);
    console.log('Header:', JSON.stringify({
      id: res.data.id,
      requisition_no: res.data.requisition_no,
      requisition_date: res.data.requisition_date,
      employee_code: res.data.employee_code,
      employee_name: res.data.employee_name,
      department_name: res.data.department_name,
      status: res.data.status,
    }, null, 2));
    console.log('Lines:', JSON.stringify(res.data.lines, null, 2));
  }
}

main().catch(console.error);
