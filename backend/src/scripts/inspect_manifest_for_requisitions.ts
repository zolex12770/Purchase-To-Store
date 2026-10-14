import fs from 'node:fs';

const manifest = JSON.parse(fs.readFileSync('C:\\Users\\Saurabh.kumar\\ZolexERP\\live-reimport-manifest-IMPORT-2026-10-13T07-34-49-212Z.json', 'utf8'));

console.log('Tab Stats:', manifest.tabStats);

const testNos = ['RN-1136', 'RN-1155', 'RN-1156', 'RN-1157', 'RN-1158', 'RN-1159', 'RN-1160', 'RN-1161', 'RN-1162', 'RN-1163', 'RN-1164', 'RN-1165', 'RN-1166'];

const reqDiscrepancies = (manifest.discrepancies || []).filter((d: any) => d.tab === 'Requisition');
console.log(`Total Requisition discrepancies: ${reqDiscrepancies.length}`);

for (const no of testNos) {
  const matching = reqDiscrepancies.filter((d: any) => d.key && d.key.includes(no));
  console.log(`Discrepancies for ${no} (${matching.length}):`);
  for (const m of matching) {
    console.log(`  Row ${m.rowNumber}: ${m.key} -> ${m.issue} -> ${m.action}`);
  }
}
