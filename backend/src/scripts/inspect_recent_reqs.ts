import { query, closeDatabase } from '../db/index.js';

async function main() {
  const headers: any = await query(
    'SELECT id, requisition_no, requisition_date, employee_code, employee_name, department_name, status FROM requisition_headers WHERE id >= 1240 ORDER BY id'
  );
  console.log(`Found ${headers.length} headers >= 1240:`);
  for (const h of headers) {
    const lines: any = await query(
      'SELECT line_no, item_code, requested_qty FROM requisition_lines WHERE requisition_id = $1 ORDER BY line_no',
      [h.id]
    );
    console.log(
      `ID ${h.id}: No=${h.requisition_no}, Date=${String(h.requisition_date).slice(0, 10)}, Emp=${h.employee_name}, Dept=${h.department_name}, Lines=[${lines.map((l: any) => `${l.item_code}(${l.requested_qty})`).join(', ')}]`
    );
  }

  // Also count total headers and total lines
  const hCnt: any = await query('SELECT COUNT(*) as c FROM requisition_headers');
  const lCnt: any = await query('SELECT COUNT(*) as c FROM requisition_lines');
  console.log(`\nTotal headers in DB: ${hCnt[0].c}, Total lines in DB: ${lCnt[0].c}`);

  await closeDatabase();
  process.exit(0);
}

main().catch(console.error);
