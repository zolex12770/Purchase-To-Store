process.env.LOG_LEVEL='warn';
const { ensureStorageDirs } = await import('./src/config/env.js');
const { getDatabase } = await import('./src/db/driver.js');
const { query } = await import('./src/db/index.js');
ensureStorageDirs(); await getDatabase();
const jobs = await import('./src/modules/google-db/jobs.js');
const { apiCallCount, resetApiCallCount } = await import('./src/modules/google-db/client.js');
const active = await jobs.activeJob();
console.log('active job:', active ? `${active.kind} sheets=[${active.sheets.join(', ')}] status=${active.status}` : 'none');
if (active) {
  resetApiCallCount();
  const t0 = Date.now();
  for (let i=0;i<200;i++){ if(!await jobs.activeJob()) break; try { const r = await jobs.runJobSlice(8000); if(r.ran) console.log(' ', r.message); } catch(e){ console.log('  paused:', e.message.slice(0,90)); await new Promise(r=>setTimeout(r,65000)); } }
  console.log(`resync done in ${((Date.now()-t0)/1000).toFixed(1)}s, ${apiCallCount()} API calls`);
}
const [p] = await query('SELECT COUNT(*)::int n FROM google_db_outbox WHERE processed_at IS NULL');
console.log('outbox pending:', p.n);
process.exit(0);
