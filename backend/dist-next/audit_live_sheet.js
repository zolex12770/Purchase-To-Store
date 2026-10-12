import { google } from 'googleapis';
import { GoogleAuth } from 'google-auth-library';
import fs from 'fs';
const keyFile = 'C:/secure/google-service-account.json';
const spreadsheetId = '1Dyj3Ws9gyR2zOe6p6RafQrKUFyLKIFN5h-3XDe9KD9I';
async function auditSheet() {
    console.log('Authenticating with Google Service Account...');
    const auth = new GoogleAuth({
        keyFile,
        scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });
    const sheets = google.sheets({ version: 'v4', auth: auth });
    console.log('Fetching spreadsheet metadata...');
    const meta = await sheets.spreadsheets.get({
        spreadsheetId,
        fields: 'sheets.properties(sheetId,title,gridProperties(rowCount,columnCount))',
    });
    const tabInfos = (meta.data.sheets || []).map((s) => ({
        title: s.properties?.title || '',
        sheetId: s.properties?.sheetId || 0,
        rowCount: s.properties?.gridProperties?.rowCount || 0,
        columnCount: s.properties?.gridProperties?.columnCount || 0,
    }));
    console.log(`\n==================================================`);
    console.log(`DISCOVERED TABS IN SPREADSHEET (${tabInfos.length} TABS TOTAL)`);
    console.log(`==================================================`);
    for (const t of tabInfos) {
        console.log(`Tab: "${t.title}" | SheetId: ${t.sheetId} | Grid: ${t.rowCount}x${t.columnCount}`);
    }
    console.log(`\n==================================================`);
    console.log(`AUDITING DATA IN ALL DISCOVERED TABS`);
    console.log(`==================================================`);
    const auditReport = [];
    for (const t of tabInfos) {
        try {
            const res = await sheets.spreadsheets.values.get({
                spreadsheetId,
                range: `'${t.title.replace(/'/g, "''")}'!A1:ZZ`,
                valueRenderOption: 'UNFORMATTED_VALUE',
                dateTimeRenderOption: 'FORMATTED_STRING',
            });
            const rows = (res.data.values || []);
            const totalRows = rows.length;
            const headerRow = rows[0] || [];
            const dataRows = rows.slice(1);
            let populatedCount = 0;
            let blankCount = 0;
            for (const r of dataRows) {
                if (r.some((cell) => cell !== null && cell !== undefined && String(cell).trim() !== '')) {
                    populatedCount++;
                }
                else {
                    blankCount++;
                }
            }
            auditReport.push({
                title: t.title,
                sheetId: t.sheetId,
                totalRows,
                headerCount: headerRow.length,
                headers: headerRow,
                populatedRows: populatedCount,
                blankRows: blankCount,
                sampleRow: dataRows[0] || null
            });
            console.log(`\n--------------------------------------------------`);
            console.log(`Tab: "${t.title}"`);
            console.log(`Total Rows Read: ${totalRows} (Header: 1, Data Rows: ${dataRows.length}, Populated: ${populatedCount}, Blank: ${blankCount})`);
            console.log(`Headers (${headerRow.length}):`, headerRow.join(' | '));
            if (dataRows.length > 0) {
                console.log(`Sample Row 1:`, dataRows[0].slice(0, 8).join(' | '));
            }
        }
        catch (err) {
            console.error(`Error reading tab "${t.title}":`, err.message);
        }
    }
    const outPath = 'c:/Users/Saurabh.kumar/Desktop/Purchase Module/tmp/live_sheet_audit_data.json';
    fs.writeFileSync(outPath, JSON.stringify(auditReport, null, 2));
    console.log(`\nSaved full audit data to ${outPath}`);
}
auditSheet().catch((e) => console.error('Audit failed:', e));
//# sourceMappingURL=audit_live_sheet.js.map