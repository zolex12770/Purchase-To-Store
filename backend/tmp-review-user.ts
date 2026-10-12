process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.SEED_DEMO_DATA = 'false';

async function main() {
  const { ensureStorageDirs } = await import('./src/config/env.js');
  const { getDatabase } = await import('./src/db/driver.js');
  ensureStorageDirs();
  const db = await getDatabase();
  const q = async (s: string) => (await db.query(s)).rows as any[];

  const { seedDemoData } = await import('./src/db/seed.js');
  try { await seedDemoData(); } catch { /* already seeded */ }

  // Ensure at least one user carries TWO roles so the fold is really exercised.
  const multi = (await q(`SELECT user_id FROM user_roles GROUP BY user_id HAVING COUNT(*)>1 LIMIT 1`))[0];
  if (!multi) {
    const u = (await q(`SELECT id FROM users WHERE deleted_at IS NULL ORDER BY id LIMIT 1`))[0];
    await db.query(`INSERT INTO user_roles (user_id, role_id)
                    SELECT ${u.id}, id FROM roles WHERE code IN ('PURCHASE_HEAD','STORE_USER')
                    ON CONFLICT DO NOTHING`);
    console.log(`(gave user ${u.id} extra roles to exercise the fold)`);
  }

  const { viewBySheet } = await import('./src/modules/google-db/views/index.js');
  const { buildViewSql } = await import('./src/modules/google-db/views/types.js');
  const view = viewBySheet('User Master')!;
  const sql = buildViewSql(view);

  console.log('=== GENERATED SQL ===');
  console.log(sql);

  console.log('\n=== base vs view ===');
  console.log('users live      :', (await q(`SELECT COUNT(*)::int n FROM users WHERE deleted_at IS NULL`))[0].n);
  console.log('users all       :', (await q(`SELECT COUNT(*)::int n FROM users`))[0].n);
  console.log('view rows       :', (await q(`SELECT COUNT(*)::int n FROM (${sql}) t`))[0].n);
  console.log('distinct User ID:', (await q(`SELECT COUNT(DISTINCT t."User ID")::int n FROM (${sql}) t`))[0].n);

  console.log('\n=== ROWS ===');
  console.table(await q(`SELECT * FROM (${sql}) t`));

  console.log('\n=== Roles cell vs ground truth ===');
  console.table(await q(`
    WITH v AS (${sql}),
    truth AS (
      SELECT u.id,
             COALESCE(string_agg(r.name, ', ' ORDER BY r.name), '') AS expected
        FROM users u
        LEFT JOIN user_roles ur ON ur.user_id = u.id
        LEFT JOIN roles r ON r.id = ur.role_id
       WHERE u.deleted_at IS NULL
       GROUP BY u.id
    )
    SELECT v."User ID", v."Roles" AS got, truth.expected,
           (v."Roles" = truth.expected) AS match
      FROM v JOIN truth ON truth.id = v."User ID"
     ORDER BY v."User ID"`));

  console.log('\n=== dept resolution ===');
  console.table(await q(`
    SELECT t."User ID", t."Employee Name", t."Department ID", t."Department"
      FROM (${sql}) t ORDER BY t."User ID"`));

  console.log('\n=== leak scan over generated SQL ===');
  const leaks = /password_hash|refresh_token|token_hash|before_data|after_data/gi;
  console.log('matches:', sql.match(leaks) ?? 'none');

  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
