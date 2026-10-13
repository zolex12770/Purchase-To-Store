import { env } from '../config/env.js';
import { google } from 'googleapis';
import { GoogleAuth } from 'google-auth-library';

async function main() {
  const auth = new GoogleAuth({
    keyFile: env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  console.log('=== DEEP ANALYSIS: LIVE GRN & REQUISITION TABS ===');

  // 1. Fetch Item Codes set from Item Master
  const itemTab = await sheets.spreadsheets.values.get({
    spreadsheetId: env.GOOGLE_SHEET_ID,
    range: "'Item Master'!A2:A",
    valueRenderOption: 'FORMATTED_VALUE',
  });
  const validItemCodes = new Set((itemTab.data.values ?? []).map((r) => (r[0] ?? '').trim()).filter(Boolean));
  console.log('Total valid Item Codes in Item Master:', validItemCodes.size);

  // 2. Analyze GRN
  console.log('\n--- ANALYZING LIVE GRN TAB (6,953 rows) ---');
  const grnRes = await sheets.spreadsheets.values.get({
    spreadsheetId: env.GOOGLE_SHEET_ID,
    range: "'GRN'!A1:AB",
    valueRenderOption: 'FORMATTED_VALUE',
  });
  const grnRows = grnRes.data.values ?? [];
  const grnHeader = grnRows[0] ?? [];
  const grnData = grnRows.slice(1).filter((r) => r.some((c) => c && String(c).trim() !== ''));

  const grnNos = new Set<string>();
  let grnMissingItem = 0;
  let grnItemInMaster = 0;
  let grnItemNotInMaster = 0;
  const missingItemCodes = new Set<string>();
  const qcStatuses = new Set<string>();
  let totalReceivedQty = 0;

  for (const r of grnData) {
    const grnNo = (r[0] ?? '').trim();
    const itemCode = (r[5] ?? '').trim();
    const qtyStr = (r[9] ?? '').replace(/,/g, '').trim();
    const qc = (r[27] ?? '').trim();

    if (grnNo) grnNos.add(grnNo);
    if (!itemCode) {
      grnMissingItem++;
    } else if (validItemCodes.has(itemCode)) {
      grnItemInMaster++;
    } else {
      grnItemNotInMaster++;
      missingItemCodes.add(itemCode);
    }
    if (qc) qcStatuses.add(qc);
    const nQty = parseFloat(qtyStr);
    if (!isNaN(nQty)) totalReceivedQty += nQty;
  }

  console.log('Total populated GRN rows:', grnData.length);
  console.log('Distinct GRN numbers:', grnNos.size);
  console.log('GRN rows with Item Code matching Item Master:', grnItemInMaster);
  console.log('GRN rows with Item Code NOT in Item Master:', grnItemNotInMaster, `(${missingItemCodes.size} distinct unknown codes)`);
  console.log('GRN rows missing Item Code:', grnMissingItem);
  console.log('Distinct QC Statuses:', Array.from(qcStatuses));
  console.log('Sum of Recieved Qty across all GRN rows:', totalReceivedQty.toFixed(4));
  console.log('Sample unknown Item Codes in GRN (first 5):', Array.from(missingItemCodes).slice(0, 5));

  // 3. Analyze Requisition
  console.log('\n--- ANALYZING LIVE REQUISITION TAB (4,953 rows) ---');
  const reqRes = await sheets.spreadsheets.values.get({
    spreadsheetId: env.GOOGLE_SHEET_ID,
    range: "'Requisition'!A1:R",
    valueRenderOption: 'FORMATTED_VALUE',
  });
  const reqRows = reqRes.data.values ?? [];
  const reqHeader = reqRows[0] ?? [];
  const reqData = reqRows.slice(1).filter((r) => r.some((c) => c && String(c).trim() !== ''));

  const reqNos = new Set<string>();
  const issueSlips = new Set<string>();
  let reqMissingItem = 0;
  let reqItemInMaster = 0;
  let reqItemNotInMaster = 0;
  const reqMissingCodes = new Set<string>();
  let rowsWithIssue = 0;
  let totalReqQty = 0;
  let totalIssuedQty = 0;

  for (const r of reqData) {
    const reqNo = (r[2] ?? '').trim();
    const itemCode = (r[3] ?? '').trim();
    const reqQtyStr = (r[5] ?? '').replace(/,/g, '').trim();
    const issueSlip = (r[14] ?? '').trim();
    const issuedQtyStr = (r[16] ?? '').replace(/,/g, '').trim();

    if (reqNo) reqNos.add(reqNo);
    if (!itemCode) {
      reqMissingItem++;
    } else if (validItemCodes.has(itemCode)) {
      reqItemInMaster++;
    } else {
      reqItemNotInMaster++;
      reqMissingCodes.add(itemCode);
    }
    const nReq = parseFloat(reqQtyStr);
    if (!isNaN(nReq)) totalReqQty += nReq;

    if (issueSlip || issuedQtyStr) {
      rowsWithIssue++;
      if (issueSlip) issueSlips.add(issueSlip);
      const nIss = parseFloat(issuedQtyStr);
      if (!isNaN(nIss)) totalIssuedQty += nIss;
    }
  }

  console.log('Total populated Requisition rows:', reqData.length);
  console.log('Distinct Requisition numbers:', reqNos.size);
  console.log('Requisition rows with Item Code matching Item Master:', reqItemInMaster);
  console.log('Requisition rows with Item Code NOT in Item Master:', reqItemNotInMaster, `(${reqMissingCodes.size} distinct unknown codes)`);
  console.log('Requisition rows with Issue data populated:', rowsWithIssue);
  console.log('Distinct Issue Slip numbers:', issueSlips.size);
  console.log('Sum of Requisition Qty:', totalReqQty.toFixed(4));
  console.log('Sum of Issued Qty:', totalIssuedQty.toFixed(4));
  console.log('Sample unknown Item Codes in Requisition (first 5):', Array.from(reqMissingCodes).slice(0, 5));
}

main().catch(console.error);
