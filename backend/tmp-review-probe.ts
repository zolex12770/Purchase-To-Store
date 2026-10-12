process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.SEED_DEMO_DATA = 'false';

async function main() {
  const { ensureStorageDirs } = await import('./src/config/env.js');
  const { getDatabase } = await import('./src/db/driver.js');
  ensureStorageDirs();
  const db = await getDatabase();
  const { viewBySheet } = await import('./src/modules/google-db/views/index.js');
  const { buildViewSql } = await import('./src/modules/google-db/views/types.js');
  const view = viewBySheet('Requisition')!;
  const sql = buildViewSql(view);

  try {
    await db.transaction(async (tx) => {
      const one = async (q: string, p: any[] = []) => (await tx.query(q, p)).rows[0] as any;

      const dept = await one(`INSERT INTO lookups (category, code, name) VALUES ('DEPARTMENT','RVW_DEP','Review Dept') RETURNING id`);
      const cc   = await one(`INSERT INTO lookups (category, code, name) VALUES ('COST_CENTRE','RVW_CC','Review CC') RETURNING id`);
      const mach = await one(`INSERT INTO lookups (category, code, name, parent_id) VALUES ('MACHINE','RVW_M1','MC-101',$1) RETURNING id`, [dept.id]);
      const uom  = await one(`INSERT INTO lookups (category, code, name) VALUES ('UOM','RVW_NOS','Review Numbers') RETURNING id`);
      const mg   = await one(`INSERT INTO lookups (category, code, name) VALUES ('MAIN_GROUP','RVW_MG','Cables & Wires') RETURNING id`);
      const smg  = await one(`INSERT INTO lookups (category, code, name, parent_id) VALUES ('SUB_MAIN_GROUP','RVW_SMG','Copper Cable',$1) RETURNING id`, [mg.id]);
      const itype= await one(`INSERT INTO lookups (category, code, name) VALUES ('ITEM_TYPE','RVW_IT','Consumable') RETURNING id`);

      const req = await one(`INSERT INTO users (employee_id, employee_name, department_id, password_hash, is_active)
                             VALUES ('EMP-R1','Ravi Requester',$1,'HASH_SECRET_R',TRUE) RETURNING id`, [dept.id]);
      const hod = await one(`INSERT INTO users (employee_id, employee_name, department_id, password_hash, is_active)
                             VALUES ('EMP-H1','Hema HOD',$1,'HASH_SECRET_H',TRUE) RETURNING id`, [dept.id]);

      const item1 = await one(`INSERT INTO items (item_code, item_description, item_type_id, main_group_id, sub_main_group_id, uom_id, live_stock_qty, is_active)
                               VALUES ('RVW-ITEM-1','Copper Cable 2.5sq',$1,$2,$3,$4,123.5,TRUE) RETURNING id`, [itype.id, mg.id, smg.id, uom.id]);
      // Item 2: no main group / no sub main group at all -> tests NULL fallbacks
      const item2 = await one(`INSERT INTO items (item_code, item_description, item_type_id, uom_id, live_stock_qty, is_active)
                               VALUES ('RVW-ITEM-2','Unclassified Widget',$1,$2,7,TRUE) RETURNING id`, [itype.id, uom.id]);

      // Header A: fully populated snapshots, machine + cost centre set
      const rhA = await one(`INSERT INTO requisition_headers
        (requisition_no, requisition_date, requisition_time, requester_user_id, employee_code, employee_name,
         department_id, department_name, hod_user_id, hod_name, machine_id, cost_centre_id, remarks, status, hod_decided_at)
        VALUES ('REQ-RVW-0001', CURRENT_DATE, '10:15', $1, 'EMP-R1-SNAP','Ravi Snapshot',$2,'Dept Snapshot',$3,'Hema Snapshot',$4,$5,'header remarks','APPROVED', now())
        RETURNING id`, [req.id, dept.id, hod.id, mach.id, cc.id]);

      // Header B: blank snapshots, NO machine, NO cost centre -> tests LEFT JOIN + fallbacks
      const rhB = await one(`INSERT INTO requisition_headers
        (requisition_no, requisition_date, requisition_time, requester_user_id, department_id, hod_user_id, status)
        VALUES ('REQ-RVW-0002', CURRENT_DATE, '11:00', $1, $2, $3, 'PENDING_APPROVAL')
        RETURNING id`, [req.id, dept.id, hod.id]);

      const lA1 = await one(`INSERT INTO requisition_lines (requisition_id, line_no, item_id, item_code, item_description, main_group_name, uom_id, requested_qty, remarks)
                             VALUES ($1,1,$2,'RVW-ITEM-1','Copper Cable 2.5sq','Snapshot Group',$3,10,'line one remarks') RETURNING id`, [rhA.id, item1.id, uom.id]);
      const lA2 = await one(`INSERT INTO requisition_lines (requisition_id, line_no, item_id, item_code, item_description, main_group_name, uom_id, requested_qty)
                             VALUES ($1,2,$2,'RVW-ITEM-2','Unclassified Widget','',$3,5) RETURNING id`, [rhA.id, item2.id, uom.id]);
      const lB1 = await one(`INSERT INTO requisition_lines (requisition_id, line_no, item_id, item_code, item_description, main_group_name, uom_id, requested_qty)
                             VALUES ($1,1,$2,'RVW-ITEM-1','Copper Cable 2.5sq','',$3,4) RETURNING id`, [rhB.id, item1.id, uom.id]);

      // Two issue slips against line A1 (4 + 3 = 7 of 10)
      const is1 = await one(`INSERT INTO requisition_issues (issue_slip_no, requisition_id, issue_date, issue_time, store_user_id)
                             VALUES ('ISS-RVW-0001',$1,CURRENT_DATE,'12:00',$2) RETURNING id`, [rhA.id, hod.id]);
      const is2 = await one(`INSERT INTO requisition_issues (issue_slip_no, requisition_id, issue_date, issue_time, store_user_id)
                             VALUES ('ISS-RVW-0002',$1,CURRENT_DATE,'13:00',$2) RETURNING id`, [rhA.id, hod.id]);
      await tx.query(`INSERT INTO requisition_issue_lines (requisition_issue_id, requisition_line_id, item_id, requested_qty_snapshot, previously_issued_qty, issue_qty, uom_id)
                      VALUES ($1,$2,$3,10,0,4,$4)`, [is1.id, lA1.id, item1.id, uom.id]);
      await tx.query(`INSERT INTO requisition_issue_lines (requisition_issue_id, requisition_line_id, item_id, requested_qty_snapshot, previously_issued_qty, issue_qty, uom_id)
                      VALUES ($1,$2,$3,10,4,3,$4)`, [is2.id, lA1.id, item1.id, uom.id]);

      // ---- FAN-OUT ----
      const vc = (await tx.query(`SELECT COUNT(*)::int n FROM (${sql}) q`)).rows[0] as any;
      const bc = (await tx.query(`SELECT COUNT(*)::int n FROM requisition_lines`)).rows[0] as any;
      console.log(`FANOUT: view=${vc.n} requisition_lines=${bc.n} -> ${vc.n === bc.n ? 'OK' : 'FAN-OUT!!!'}`);

      const dup = (await tx.query(`SELECT COUNT(*)::int n FROM (SELECT q."Requisition ID", q."Requisition Line ID" FROM (${sql}) q GROUP BY 1,2 HAVING COUNT(*)>1) d`)).rows[0] as any;
      console.log(`DUPKEY: ${dup.n}`);

      const rows = (await tx.query(`${sql}`)).rows as any[];
      for (const r of rows) {
        console.log('---------------------------------------------');
        for (const [k, v] of Object.entries(r)) console.log(`  ${k.padEnd(24)} | ${v === null ? '<NULL>' : String(v)}`);
      }
      throw new Error('ROLLBACK_ON_PURPOSE');
    });
  } catch (e: any) {
    if (!String(e.message).includes('ROLLBACK_ON_PURPOSE')) throw e;
    console.log('\n(transaction rolled back)');
  }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
