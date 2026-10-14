import { query, withTransaction } from '../db/index.js';

interface Rule {
  deptName: string;
  hodName: string;
  empId?: string;
  userId?: number;
  secondaryUserId?: number;
  secondaryHodName?: string;
}

const AUTHORITATIVE_RULES: Rule[] = [
  { deptName: 'General', hodName: 'Mr. Naresh', userId: 15 },
  { deptName: 'Planning', hodName: 'Mr. Rajeev', userId: 44 },
  { deptName: 'Tinning', hodName: 'Mr. Anshul', userId: 428, secondaryUserId: 17, secondaryHodName: 'Mr. Gopal' },
  { deptName: 'Packing', hodName: 'Mr.Abhishek', userId: 235 },
  { deptName: 'House Keeping', hodName: 'Mr.Nainesh Patel', userId: 12 },
  { deptName: 'Printing', hodName: 'Mr.Rajni', userId: 23 },
  { deptName: 'Sheet Metal', hodName: 'Mr. Pradyumna', userId: 57 },
  { deptName: 'Maintenance', hodName: 'Mr. Subhash', userId: 54 },
  { deptName: 'Tool Room', hodName: 'Mr.Brijesh', userId: 14 },
  { deptName: 'Re Draw', hodName: 'Mr. Rajeev', userId: 44 },
  { deptName: 'Power Press', hodName: 'Mr.Ranvijay', userId: 18 },
  { deptName: 'Civil & Construction', hodName: 'Mr. Nainesh Rana', userId: 26 },
  { deptName: 'Cutting', hodName: 'Mr.Rajeev', userId: 44 },
  { deptName: 'Bi-Metalic', hodName: 'Mr. Pradyumna', userId: 57 },
  { deptName: 'Admin', hodName: 'Mr. Manish', userId: 11 },
  { deptName: 'Utility', hodName: 'Mr. Subhash', userId: 54 },
  { deptName: 'Quality', hodName: 'Mr. Hitesh', userId: 28 },
  { deptName: 'Sales & Marketing', hodName: 'Mr. Manish', userId: 11 },
  { deptName: 'Saddle & Brackets', hodName: 'Mr. Chintu', userId: 397 },
  { deptName: 'Annealing', hodName: 'Mr. Sachin', userId: 147 },
  { deptName: 'Store', hodName: 'Mr. Bharat', userId: 13 },
  { deptName: 'Account', hodName: 'Mr. Martin', userId: 47 },
  { deptName: 'HR', hodName: 'Mr.Nainesh Patel', userId: 12 },
  { deptName: 'Ul Lab', hodName: 'Mr. Hitesh', userId: 28 },
  { deptName: 'Design', hodName: 'Mr.Brijesh', userId: 14 },
  { deptName: 'IT', hodName: 'Mr. Nitesh', userId: 224 },
  { deptName: 'MDO', hodName: 'Kunal Raju Dulani', userId: 1, empId: '10221' },
];

async function main() {
  console.log('=== Reconciling Department HODs & Roles ===');

  await withTransaction(async (tx) => {
    // 1. Ensure role HOD exists
    let hodRole = (await tx.query("SELECT id FROM roles WHERE code = 'HOD'")).rows[0];
    if (!hodRole) {
      const ins = await tx.query(`
        INSERT INTO roles (code, name, description, is_system, is_active)
        VALUES ('HOD', 'HOD', 'Department Head: approves and decides material requisitions.', true, true)
        RETURNING id
      `);
      hodRole = ins.rows[0];
      console.log('Created HOD role with ID:', hodRole.id);
    } else {
      console.log('Found existing HOD role ID:', hodRole.id);
    }

    // Ensure permissions for HOD role
    const perms = ['requisition.view', 'requisition.create', 'requisition.edit', 'requisition.approve', 'requisition.print'];
    for (const p of perms) {
      const pRow = (await tx.query("SELECT id FROM permissions WHERE code = $1", [p])).rows[0];
      if (pRow) {
        await tx.query(`
          INSERT INTO role_permissions (role_id, permission_id)
          VALUES ($1, $2)
          ON CONFLICT DO NOTHING
        `, [hodRole.id, pRow.id]);
      }
    }

    const employeeRole = (await tx.query("SELECT id FROM roles WHERE code = 'EMPLOYEE'")).rows[0]?.id;

    // 2. Fetch all departments
    const depts = (await tx.query("SELECT id, code, name, extra FROM lookups WHERE category = 'DEPARTMENT' AND deleted_at IS NULL")).rows;
    console.log(`Auditing against ${depts.length} database department lookups...`);

    const hodUserIds = new Set<number>();

    for (const rule of AUTHORITATIVE_RULES) {
      const cleanDept = rule.deptName.trim().toLowerCase();
      // Match department in lookups
      const matchedDepts = depts.filter((d: any) => {
        const dName = (d.name || '').trim().toLowerCase();
        const dCode = (d.code || '').trim().toLowerCase();
        return dName === cleanDept || 
               dName === rule.deptName.toLowerCase() ||
               dCode === cleanDept.replace(/[^a-z0-9]/g, '_') ||
               dCode === ('dep_' + cleanDept.replace(/[^a-z0-9]/g, '_'));
      });

      if (matchedDepts.length === 0) {
        console.warn(`WARNING: Department "${rule.deptName}" NOT matched in lookups!`);
        continue;
      }

      // Check user
      let uId = rule.userId;
      if (!uId && rule.empId) {
        const u = (await tx.query("SELECT id FROM users WHERE employee_id = $1 AND deleted_at IS NULL", [rule.empId])).rows[0];
        uId = u?.id;
      }

      if (!uId) {
        console.error(`ERROR: No user found for rule ${rule.deptName} -> ${rule.hodName}`);
        continue;
      }

      hodUserIds.add(uId);
      if (rule.secondaryUserId) hodUserIds.add(rule.secondaryUserId);

      for (const d of matchedDepts) {
        const curExtra = typeof d.extra === 'object' && d.extra ? d.extra : {};
        const newExtra: Record<string, unknown> = {
          ...curExtra,
          hodName: rule.hodName,
          hodUserId: uId,
        };
        if (rule.secondaryUserId) {
          newExtra.secondaryHodUserId = rule.secondaryUserId;
          newExtra.secondaryHodName = rule.secondaryHodName;
        }

        await tx.query(
          "UPDATE lookups SET extra = $1, updated_at = now() WHERE id = $2",
          [JSON.stringify(newExtra), d.id],
        );
        console.log(`✓ Updated Dept ID=${d.id} (${d.name}): hodUserId=${uId}, hodName="${rule.hodName}"`);
      }
    }

    // 3. Grant HOD and EMPLOYEE roles to all HOD users
    console.log(`\nGranting HOD & EMPLOYEE roles to ${hodUserIds.size} HOD users...`);
    for (const uid of hodUserIds) {
      if (hodRole?.id) {
        await tx.query("INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [uid, hodRole.id]);
      }
      if (employeeRole) {
        await tx.query("INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [uid, employeeRole]);
      }
      const u = (await tx.query("SELECT employee_id, employee_name FROM users WHERE id = $1", [uid])).rows[0];
      console.log(`  ✓ Roles granted to User ID=${uid} (${u?.employee_name} · ${u?.employee_id})`);
    }

    // Verify Kunal Raju Dulani specifically
    const kunal = (await tx.query(`
      SELECT u.id, u.employee_id, u.employee_name,
             (dept.extra->>'hodUserId')::bigint = u.id AS is_mdo_hod
        FROM users u
        LEFT JOIN lookups dept ON dept.id = u.department_id
       WHERE u.employee_id = '10221'
    `)).rows[0];
    console.log('\nVerification of Kunal Raju Dulani (10221):', kunal);
  });

  console.log('\n=== Reconcile complete successfully ===');
}

main().catch(console.error);
