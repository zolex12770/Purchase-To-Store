import fs from 'node:fs';
import { execSync } from 'node:child_process';
import { getDatabase } from './dist/db/index.js';

async function main() {
  let report = '# PHASE 1 — BASELINE CAPTURE REPORT\n\n';
  report += `Timestamp: ${new Date().toISOString()}\n\n`;

  // Process & Port baseline
  report += '## 1. Process & Listening Ports Baseline\n';
  try {
    const net = execSync('netstat -ano | findstr ":8080 :4001 :4100 :4200 :5200"').toString();
    report += '```\n' + net + '\n```\n';
  } catch (e) {
    report += 'Netstat err: ' + e.message + '\n';
  }

  try {
    const pm2 = execSync('npx pm2 list').toString();
    report += '\n### PM2 List\n```\n' + pm2 + '\n```\n';
  } catch (e) {
    report += 'PM2 err: ' + e.message + '\n';
  }

  // Database Baseline
  report += '\n## 2. Database Baseline\n';
  try {
    const db = await getDatabase();
    
    report += `Database Driver: ${db.driver}\n`;

    // Tables
    const tablesRes = await db.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `);
    
    report += `Total Tables: ${tablesRes.rows.length}\n\n`;
    report += '| Table Name | Actual Row Count |\n|---|---:|\n';
    
    for (const row of tablesRes.rows) {
      const countRes = await db.query(`SELECT COUNT(*) as cnt FROM "${row.table_name}"`);
      report += `| ${row.table_name} | ${countRes.rows[0].cnt} |\n`;
    }

    // Detailed Columns for each table
    report += '\n### Table Schemas & Columns\n';
    let totalColumns = 0;
    for (const row of tablesRes.rows) {
      const colRes = await db.query(`
        SELECT column_name, data_type, is_nullable, column_default
        FROM information_schema.columns
        WHERE table_name = '${row.table_name}'
        ORDER BY ordinal_position
      `);
      totalColumns += colRes.rows.length;
      report += `\n#### Table: \`${row.table_name}\` (${colRes.rows.length} columns)\n`;
      report += '| Column | Data Type | Nullable | Default |\n|---|---|---|---|\n';
      for (const col of colRes.rows) {
        report += `| ${col.column_name} | ${col.data_type} | ${col.is_nullable} | ${col.column_default || ''} |\n`;
      }
    }
    report += `\nTotal Columns across all tables: ${totalColumns}\n`;

    // Constraints & FKs
    const fkRes = await db.query(`
      SELECT
        tc.table_name, kcu.column_name, 
        ccu.table_name AS foreign_table_name,
        ccu.column_name AS foreign_column_name 
      FROM 
        information_schema.table_constraints AS tc 
        JOIN information_schema.key_column_usage AS kcu
          ON tc.constraint_name = kcu.constraint_name
        JOIN information_schema.constraint_column_usage AS ccu
          ON ccu.constraint_name = tc.constraint_name
      WHERE tc.constraint_type = 'FOREIGN KEY'
      ORDER BY tc.table_name
    `);

    report += '\n### Foreign Keys\n';
    report += '| Table | Column | Foreign Table | Foreign Column |\n|---|---|---|---|\n';
    for (const fk of fkRes.rows) {
      report += `| ${fk.table_name} | ${fk.column_name} | ${fk.foreign_table_name} | ${fk.foreign_column_name} |\n`;
    }

  } catch (err) {
    report += 'DB Error: ' + err.stack + '\n';
  }

  fs.writeFileSync('c:/tmp/phase1_baseline.md', report, 'utf8');
  console.log('Saved Phase 1 baseline to c:/tmp/phase1_baseline.md');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
