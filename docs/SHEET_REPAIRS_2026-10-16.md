# Inventory sheet repairs (2026-10-16)

**For:** the owner of the five inventory spreadsheets (the person who can edit their protected ranges).

The ERP reads these sheets with a read-only account, and every stock tab is protected, so these repairs must be made in Google Sheets by you. Every repair below only changes formulas inside existing cells. The figures were checked by re-computing all 200,524 monthly cells of the five stock tabs.

## Do not move anything

Planning and job-card workbooks pull these columns **by position** with IMPORTRANGE:

- 'RM Stock Live' A–G
- 'WIP  Stock Live' A–K
- 'RM Outward' J–L

Do not insert, delete or move columns in those ranges, and do not rename the tabs.

In the formulas below, `{r}` means the cell's own row number.

## 1. Trading — wrong stock today (do this first)

Spreadsheet `14AHr2aSmpcCxfNhcWnjGU1DVE-BfJpLOWrnFn3bkilk`, tab **Trading Live Stock**. Rewrite J10:BE214 so that every row refers to its own item and every range is open-ended. For month k = 0…11 (Apr-26 … Mar-27):

| Column | Formula |
|---|---|
| Inward (J + 4k) | `=SUMIFS('Inward Trading'!$J$8:$J,'Inward Trading'!$E$8:$E,$B{r},'Inward Trading'!$B$8:$B,"<month>")` |
| Inward value (K + 4k) | `=IFERROR(<inward column>{r}*$G{r}," ")` |
| Outward (L + 4k) | `=SUMIFS('Outward Trading '!$I$7:$I,'Outward Trading '!$E$7:$E,$B{r},'Outward Trading '!$B$7:$B,"<month>")` |
| Outward value (M + 4k) | `=IFERROR(<outward column>{r}*$G{r}," ")` |

`<month>` is `Apr-26`, `May-26`, … `Dec-26`, then **`Jan-27`, `Feb-27`, `Mar-27`**.

What this fixes:

- **Row 25 (ZBT12N)** reads row 26 in R:Y and AL:AS. H25 shows **160**; the correct stock is **2,260** (opening 620 + inward 6,578 − outward 4,938). Row 125 has the same fault, with no effect yet.
- **Jan/Feb/Mar columns** (AT, AV, AX, AZ, BB, BD) count `Jan-26`, `fEB-26` and `Mar-26` instead of the 2027 months. They show 0 today, but every January–March 2027 movement would be missed.
- Ranges that stop at today's last row ($596 / $1011), and the blank J:M on rows 186–193.

Expected result: H25 160 → 2,260 and I25 9,398.4 → 132,752.4. No other stock figure changes.

## 2. WIP — before about 1 December 2026

Spreadsheet `1BirIwXOG4F604q5n1UY0r6kjet4mTdmbhC9FDbTrUXs`, tab **WIP  Stock Live**. The totals leave out December to March.

- K11:K737: `=(BZ{r}+M{r}+Q{r}+U{r}+Y{r}+AC{r}+AG{r}+AK{r}+AO{r}+AS{r}+AW{r}+BA{r}+BE{r})-O{r}-S{r}-W{r}-AA{r}-AE{r}-AI{r}-AM{r}-AQ{r}-AU{r}-AY{r}-BC{r}-BG{r}+CD{r}`
- L11:L737: `=if(K{r}=0,"0",(CA{r}+N{r}+R{r}+V{r}+Z{r}+AD{r}+AH{r}+AL{r}+AP{r}+AT{r}+AX{r}+BB{r}+BF{r})-P{r}-T{r}-X{r}-AB{r}-AF{r}-AJ{r}-AN{r}-AR{r}-AV{r}-AZ{r}-BD{r}-BH{r})`

No figure changes today; from December both the sheet and the ERP would otherwise be wrong.

## 3. General

Spreadsheet `1VnpDk6kBK2xUGJTVB1CCqlG105UX0_Gs0aAv-bnMpKY`, tab **General Item Live Stock**:

- **Adjustment formula missing on new rows.** BK2403:BK4402: `=SUMIFS('Stock Adjustment'!$H$2:$H,'Stock Adjustment'!$D$2:$D,B{r})`
- **Rack column shows the Item Master's "Repetition" count, not the rack.** In the formula cells of G8:G2637, use `=IFERROR(VLOOKUP(B{r},'Item Master'!$B$8:$I,8,FALSE),"")`. Today the ERP holds number-only rack IDs for 2,340 items because of this.
- Helper cells:
  - BG134:BG154: `=if(OR(H{r}=0,H{r}=""), ,1)`
  - AU5: `=ROUND(SUBTOTAL(9,AU8:AU)/100000,2) & " Lakhs"`

## 4. RM

Spreadsheet `1smKiS3li81F7aH2pQ0JGgDLp7302d48FJkvWefRf8R4`:

- 'RM Stock Live'!BM10:BM1001: `=if(B{r}="", ,sumifs('Stock Adjustment'!$H$2:$H,'Stock Adjustment'!$D$2:$D,B{r}))`
- 'RM Outward' rows 4189–4190 read the next row. Point them at their own row:
  - C: `=if(E{r}="","",text(E{r},"MMM-YY"))`
  - D: `=if(E{r}="",,TEXT(E{r},"MMM") & " - Wk" & ROUNDUP(DAY(E{r})/7,0))`
  - B: `=R{r}`

## 5. FG — rows that are not counted

Spreadsheet `1mA5il8Jqjgal9g20o-UzqQGv3y-mgPHpjl9KU-XomyQ`:

- **'Inward FG ' B4439, B5139:B5143, B5387:B5388.** The Month formula was deleted, so 7,748 Nos are not counted:

  | Item | Nos |
  |---|---|
  | ZR7030 | 1,498 |
  | ZCT551 | 3,542 |
  | ZCT355 | 2,318 |
  | LEZAUS9512 | 147 |
  | LEZAUS256BM | 115 |
  | LEZAUS2510BM | 94 |
  | LEZAUSWN30010 | 22 |
  | LEZAUSN958 | 12 |

  If these are genuine receipts, restore `=if(C{r}="","",text(C{r},"MMM-YY"))` in each cell. LEZAUS9512 also appears on row 4912 with the same job card, so check that one first.
- **'Outward FG' row 2596.** Its formulas read row 2612, and C2596 has no date, so 458 Nos of LERM-ABBCMP1 are not counted. Point A, B and Q at row 2596, then enter the issue date in C2596 (the rows around it are dated 07-08-26).
- **'Outward FG' B3587:B3588.** The Month cells hold a typed date. Restore the Month formula.

## 6. WIP movements — typed dates in Month cells

Restore `=if(C{r}="","",text(C{r},"MMM-YY"))` in:

- 'Inward WIP'!B257:B259
- 'Outward WIP'!B125:B126

Typing "Oct-26" stores a date. It counts today only because Sheets reads the criterion as 26 October of the current year, and it may stop counting in 2027.

## 7. Business decisions needed

The full lists with sheet rows are with the ERP administrator (exceptions.json from the 2026-10-16 audit).

- 238 movement rows are awaiting store verification. Examples: 210 FG rows / 111,064 Nos, of which 74 are older than 90 days; Trading ZSFIB519L12P 500,000.
- 54 movement rows use item codes that are not in the stock tab. Suggestions are included, e.g. ZR7140M6 → ZR7140-M6; TIM, CHM091 and PLRM005 are in the RM spreadsheet.
- 'RM Outward'!G2920 has no item code (13.4 kg, job card CT263662).
- 6 items show negative stock; count them and record an adjustment. Examples: FRDCUETP38.5 −0.1, PIA24 −25.
- 'Inward WIP' row 21 repeats row 19 (ZR7132, 1,045, 16-04-26). Delete it if it is a duplicate.
- General Item Master lists 62 codes twice (64 extra rows). **Clear** the duplicate rows rather than deleting them: column B of the stock tab follows the Item Master row by row.

## 8. After the repairs

Ask the ERP administrator to run **Sync with Sheet → dry run** for each category. The ERP checks every item against its own computation from the movement rows; ZBT12N must then show "Matches sheet".
