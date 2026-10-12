import { chromium } from 'playwright';

const browser = await chromium.launch();
const context = await browser.newContext({ storageState: 'C:\\Users\\SAURAB~1.KUM\\AppData\\Local\\Temp\\claude\\c--Users-Saurabh-kumar-Desktop-Purchase-Module\\59369a54-d451-4d77-b383-ccbabb133fbc\\scratchpad\\auth.json' });
const page = await context.newPage();
await page.goto('http://localhost:8080/dashboard', { waitUntil: 'networkidle' });

const bundle = await page.evaluate(async () => {
  const r = await fetch('/api/v1/auth/refresh', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' } });
  const j = await r.json();
  const token = j.data?.accessToken;
  const h = { Authorization: `Bearer ${token}` };

  const indents = await (await fetch('/api/v1/indents?pageSize=20', { headers: h })).json();
  const pos = await (await fetch('/api/v1/purchase-orders?pageSize=20', { headers: h })).json();
  const grns = await (await fetch('/api/v1/grn?pageSize=20', { headers: h })).json();
  const labels = await (await fetch('/api/v1/grn/labels?pageSize=10', { headers: h })).json();
  return { token, indents, pos, grns, labels };
});

console.log('INDENTS:', JSON.stringify(bundle.indents.data?.map(i => ({
  id: i.id, no: i.indent_no, status: i.status, by: i.requested_by_name, byCode: i.requested_by_code,
})), null, 2));
console.log('POS:', JSON.stringify(bundle.pos.data?.map(p => ({ id: p.id, no: p.po_no, status: p.status })), null, 2));
console.log('GRNS:', JSON.stringify(bundle.grns.data?.map(g => ({ id: g.id, no: g.grn_no, status: g.status, mode: g.is_po_based })), null, 2));
console.log('LABELS meta:', JSON.stringify(bundle.labels.meta));
console.log('LABELS sample:', JSON.stringify(bundle.labels.data?.slice(0, 3), null, 2));
