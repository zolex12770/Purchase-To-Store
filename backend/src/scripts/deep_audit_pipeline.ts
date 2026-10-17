import { google } from 'googleapis';
import { GoogleAuth } from 'google-auth-library';
import { requireGoogleKeyFile } from '../config/google.js';
import { scriptApiTarget, scriptCredentials } from './script-target.js';

// Target and account come from the environment; production needs ZOLEX_ALLOW_PRODUCTION=yes.
const SCRIPT_API = scriptApiTarget();
const SCRIPT_LOGIN = scriptCredentials();

interface CatConfig {
  category: string;
  spreadsheetId: string;
  stockTab: string;
  stockRange: string;
  headerRowInArray: number; // 0-based index in fetched range where column headers are
  dataStartRowInArray: number; // 0-based index in fetched range where data starts
  codeCol: number;
  descCol: number;
  qtyCol: number;
  weightCol?: number;
  uomCol?: number;
  rackCol?: number;
  rateCol?: number;
  amountCol?: number;
}

const CONFIGS: CatConfig[] = [
  {
    category: 'RM',
    spreadsheetId: '1smKiS3li81F7aH2pQ0JGgDLp7302d48FJkvWefRf8R4',
    stockTab: 'RM Stock Live',
    stockRange: "'RM Stock Live'!A1:Z1200",
    headerRowInArray: 8, // Row 9
    dataStartRowInArray: 9, // Row 10
    codeCol: 1, // Col B
    descCol: 2, // Col C
    qtyCol: 6, // Col G: Live Stock KG
    weightCol: 6,
    rackCol: 5, // Col F: Rack ID
    amountCol: 7, // Col H: Amount
  },
  {
    category: 'FG',
    spreadsheetId: '1mA5il8Jqjgal9g20o-UzqQGv3y-mgPHpjl9KU-XomyQ',
    stockTab: 'FG  Stock Live',
    stockRange: "'FG  Stock Live'!A1:Z5000",
    headerRowInArray: 10, // Row 11
    dataStartRowInArray: 11, // Row 12
    codeCol: 1, // Col B
    descCol: 5, // Col F
    qtyCol: 7, // Col H: Nos
    weightCol: 8, // Col I: Kgs
    rackCol: 6, // Col G: Rack Id
  },
  {
    category: 'TRADING',
    spreadsheetId: '14AHr2aSmpcCxfNhcWnjGU1DVE-BfJpLOWrnFn3bkilk',
    stockTab: 'Trading Live Stock',
    stockRange: "'Trading Live Stock'!A1:Z600",
    headerRowInArray: 8, // Row 9
    dataStartRowInArray: 9, // Row 10
    codeCol: 1, // Col B
    descCol: 2, // Col C
    uomCol: 4, // Col E
    rackCol: 5, // Col F
    rateCol: 6, // Col G
    qtyCol: 7, // Col H: Qty
    amountCol: 8, // Col I: Amount
  },
  {
    category: 'WIP',
    spreadsheetId: '1BirIwXOG4F604q5n1UY0r6kjet4mTdmbhC9FDbTrUXs',
    stockTab: 'WIP  Stock Live',
    stockRange: "'WIP  Stock Live'!A1:Z1000",
    headerRowInArray: 9, // Row 10
    dataStartRowInArray: 10, // Row 11
    codeCol: 0, // Col A
    descCol: 8, // Col I
    rackCol: 9, // Col J
    qtyCol: 10, // Col K: Nos
    weightCol: 11, // Col L: Kgs
  },
  {
    category: 'GENERAL',
    spreadsheetId: '1VnpDk6kBK2xUGJTVB1CCqlG105UX0_Gs0aAv-bnMpKY',
    stockTab: 'General Item Live Stock',
    stockRange: "'General Item Live Stock'!A1:Z5000",
    headerRowInArray: 6, // Row 7
    dataStartRowInArray: 7, // Row 8
    codeCol: 1, // Col B
    descCol: 2, // Col C
    uomCol: 4, // Col E
    rackCol: 6, // Col G
    qtyCol: 7, // Col H: Qty
    amountCol: 8, // Col I: Amount
  },
];

async function deepAudit() {
  const auth = new GoogleAuth({
    keyFile: requireGoogleKeyFile('Nothing was read.'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const sheets = google.sheets({ version: 'v4', auth: auth as never });

  // Login to ERP API to get current database state
  const loginRes = await fetch(`${SCRIPT_API.baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(SCRIPT_LOGIN),
  });
  const loginData = (await loginRes.json()) as any;
  const token = loginData.data?.accessToken;
  const apiHeaders = { Authorization: `Bearer ${token}` };

  console.log('=== COMPREHENSIVE PIPELINE AUDIT FOR ALL 5 CATEGORIES ===\n');

  for (const cfg of CONFIGS) {
    console.log(`================================================================================`);
    console.log(`AUDITING CATEGORY: ${cfg.category}`);
    console.log(`Sheet ID: ${cfg.spreadsheetId} | Tab: "${cfg.stockTab}"`);

    // 1. Fetch Formatted Values
    const resFormatted = await sheets.spreadsheets.values.get({
      spreadsheetId: cfg.spreadsheetId,
      range: cfg.stockRange,
      valueRenderOption: 'FORMATTED_VALUE',
    });
    const rows = resFormatted.data.values || [];
    console.log(`Total rows returned by range: ${rows.length}`);

    // Headers
    const headers = rows[cfg.headerRowInArray] || [];
    console.log(`Header row (${cfg.headerRowInArray + 1}):`, headers.slice(0, 15));

    // Data rows
    const dataRows = rows.slice(cfg.dataStartRowInArray);
    console.log(`Data rows count: ${dataRows.length}`);

    let totalNonEmpty = 0;
    let blankCodes = 0;
    let duplicateCodes = 0;
    let formulaOrTotalRows = 0;
    let negativeQty = 0;
    let zeroQty = 0;
    let positiveQty = 0;
    let sumQty = 0;
    let sumWeight = 0;
    let sumAmount = 0;

    const seenCodes = new Set<string>();
    const dupMap = new Map<string, number>();
    const samplesNegative: any[] = [];
    const samplesQuarantined: any[] = [];

    for (let i = 0; i < dataRows.length; i++) {
      const row = dataRows[i];
      const rawCode = row[cfg.codeCol];

      if (!rawCode || String(rawCode).trim() === '') {
        blankCodes++;
        continue;
      }

      const codeStr = String(rawCode).trim();

      // Check if it's a summary/header row accidentally at bottom
      if (codeStr.startsWith('=') || codeStr.toLowerCase().includes('total') || codeStr.toLowerCase().includes('grand')) {
        formulaOrTotalRows++;
        continue;
      }

      totalNonEmpty++;

      if (seenCodes.has(codeStr.toUpperCase())) {
        duplicateCodes++;
        dupMap.set(codeStr.toUpperCase(), (dupMap.get(codeStr.toUpperCase()) || 1) + 1);
      } else {
        seenCodes.add(codeStr.toUpperCase());
      }

      // Parse Qty
      const rawQty = cfg.qtyCol >= 0 && row[cfg.qtyCol] ? String(row[cfg.qtyCol]).replace(/,/g, '').trim() : '0';
      const parsedQty = parseFloat(rawQty);

      if (isNaN(parsedQty)) {
        samplesQuarantined.push({ row: i + cfg.dataStartRowInArray + 1, code: codeStr, rawQty, reason: 'NaN' });
      } else if (parsedQty < 0) {
        negativeQty++;
        samplesNegative.push({ row: i + cfg.dataStartRowInArray + 1, code: codeStr, qty: parsedQty });
      } else if (parsedQty === 0) {
        zeroQty++;
      } else {
        positiveQty++;
        sumQty += parsedQty;
      }

      // Parse Weight
      if (cfg.weightCol !== undefined && cfg.weightCol >= 0 && row[cfg.weightCol]) {
        const rawW = String(row[cfg.weightCol]).replace(/,/g, '').trim();
        const w = parseFloat(rawW);
        if (!isNaN(w) && w > 0) {
          sumWeight += w;
        }
      }

      // Parse Amount
      if (cfg.amountCol !== undefined && cfg.amountCol >= 0 && row[cfg.amountCol]) {
        const rawA = String(row[cfg.amountCol]).replace(/,/g, '').trim();
        const a = parseFloat(rawA);
        if (!isNaN(a) && a > 0) {
          sumAmount += a;
        }
      }
    }

    console.log(`SOURCE METRICS:`);
    console.log(`  - Total Non-Empty Item Codes: ${totalNonEmpty}`);
    console.log(`  - Unique Item Codes: ${seenCodes.size}`);
    console.log(`  - Duplicate Codes in Sheet: ${duplicateCodes}`);
    console.log(`  - Blank/Empty Rows: ${blankCodes}`);
    console.log(`  - Total/Formula Rows Filtered: ${formulaOrTotalRows}`);
    console.log(`  - Negative Qty Items: ${negativeQty}`);
    console.log(`  - Zero Qty Items: ${zeroQty}`);
    console.log(`  - Positive Qty Items: ${positiveQty}`);
    console.log(`  - Sum of Positive Stock Qty: ${sumQty.toFixed(4)}`);
    if (cfg.weightCol !== undefined) {
      console.log(`  - Sum of Weight (Kg): ${sumWeight.toFixed(4)} (Ton: ${(sumWeight / 1000).toFixed(4)})`);
    }
    if (cfg.amountCol !== undefined) {
      console.log(`  - Sum of Amount (Rs): ${sumAmount.toFixed(2)} (Lakhs: ${(sumAmount / 100000).toFixed(2)})`);
    }
    if (samplesNegative.length > 0) {
      console.log(`  - Negative Samples:`, samplesNegative.slice(0, 5));
    }
    if (dupMap.size > 0) {
      console.log(`  - Duplicate Code Samples:`, Array.from(dupMap.entries()).slice(0, 5));
    }

    // 2. Fetch ERP Database stats for this category
    const dbSummaryRes = await fetch(`${SCRIPT_API.baseUrl}/inventory/categories/${cfg.category}/summary`, { headers: apiHeaders });
    const dbSummary = (await dbSummaryRes.json()) as any;
    const dbStats = dbSummary.data?.stats;

    console.log(`DATABASE METRICS (Live ERP):`);
    console.log(`  - Total Items in DB: ${dbStats?.totalItems}`);
    console.log(`  - Total Stock Qty: ${dbStats?.totalStockQty}`);
    console.log(`  - Total Weight (Kg): ${dbStats?.totalWeightKg} (Ton: ${dbStats?.totalWeightTon})`);
    console.log(`  - Total Valuation: ${dbStats?.totalValuation}`);

    // Compare
    const itemDiff = totalNonEmpty - (dbStats?.totalItems || 0);
    const qtyDiff = sumQty - (dbStats?.totalStockQty || 0);
    console.log(`RECONCILIATION DIFFERENCE:`);
    console.log(`  - Items Difference: ${itemDiff} (Source - DB)`);
    console.log(`  - Qty Difference: ${qtyDiff.toFixed(4)} (Source - DB)`);
  }
}

deepAudit().catch(console.error);
