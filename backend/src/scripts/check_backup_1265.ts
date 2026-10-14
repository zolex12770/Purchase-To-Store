import fs from 'node:fs';

const backupPath = 'C:\\Users\\Saurabh.kumar\\ZolexERP\\backups\\zolex-backup-2026-10-13T11-42-59-754Z.json';
const data = JSON.parse(fs.readFileSync(backupPath, 'utf8'));

console.log('Top keys of backup:', Object.keys(data));
if (data.data) {
  console.log('Data keys:', Object.keys(data.data));
  const headers = data.data.requisition_headers || [];
  const lines = data.data.requisition_lines || [];
  console.log('Headers count:', headers.length);
  const highHeaders = headers.filter((h: any) => h.id >= 1265);
  for (const h of highHeaders) {
    const hLines = lines.filter((l: any) => l.requisition_id === h.id);
    console.log(`ID ${h.id}: No=${h.requisition_no}, Date=${h.requisition_date}, Emp=${h.employee_name}, Lines=[${hLines.map((l: any) => `${l.item_code}(${l.requested_qty})`).join(', ')}]`);
  }
}
for (const h of highHeaders) {
  const hLines = lines.filter((l: any) => l.requisition_id === h.id);
  console.log(`ID ${h.id}: No=${h.requisition_no}, Date=${h.requisition_date}, Emp=${h.employee_name}, Lines=[${hLines.map((l: any) => `${l.item_code}(${l.requested_qty})`).join(', ')}]`);
}
