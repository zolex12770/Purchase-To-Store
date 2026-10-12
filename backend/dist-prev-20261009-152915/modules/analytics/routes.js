/**
 * Management Analysis (SRS §13, §14, §38; ADR-009).
 *
 * Every figure here is computed from the SAME balance views the operational
 * screens read (`v_po_line_balance`, `v_indent_line_balance`, `v_po_header_balance`).
 * That is what makes the dashboard reconcile with the transaction lists by
 * construction — there is no second definition of "pending" anywhere.
 *
 * Every response carries `filters` and `generatedAt` so the UI can show active
 * filter context and data freshness (SRS §38, §44).
 */
import { Router } from 'express';
import { z } from 'zod';
import { query, SqlBuilder } from '../../db/index.js';
import { asyncHandler, sendOk, validateQuery, parsedQuery, universalFilterSchema, } from '../../core/http.js';
import { requirePermission, requireAnyPermission } from '../../auth/middleware.js';
import { METRICS, AGEING_BUCKETS, ageingCase } from '../../domain/metrics.js';
import { dec, shareOf, pctChange } from '../../domain/money.js';
import { ValidationError } from '../../core/errors.js';
const router = Router();
/* ── Filter plumbing ────────────────────────────────────────────────────────── */
/** Applies the universal filter to a PO-line query (alias `v` = v_po_line_balance). */
function poLineFilter(f, opts = {}) {
    const b = new SqlBuilder();
    if (opts.excludeCancelled !== false)
        b.addRaw("v.po_status <> 'CANCELLED'");
    b.add('v.po_date >= ?', f.dateFrom);
    b.add('v.po_date <= ?', f.dateTo);
    b.addIn('v.supplier_id', f.supplierId);
    b.addIn('v.item_id', f.itemId);
    b.addIn('v.po_type_id', f.poTypeId);
    b.addIn('v.po_status', f.status);
    // Item-master dimensions require a join to `items`; declared by the caller.
    if (f.departmentId?.length || f.costCentreId?.length || f.mainGroupId?.length ||
        f.subMainGroupId?.length || f.itemTypeId?.length) {
        const parts = [];
        if (f.departmentId?.length)
            parts.push(`i.department_id = ANY(${b.push(f.departmentId)})`);
        if (f.costCentreId?.length)
            parts.push(`i.cost_centre_id = ANY(${b.push(f.costCentreId)})`);
        if (f.mainGroupId?.length)
            parts.push(`i.main_group_id = ANY(${b.push(f.mainGroupId)})`);
        if (f.subMainGroupId?.length)
            parts.push(`i.sub_main_group_id = ANY(${b.push(f.subMainGroupId)})`);
        if (f.itemTypeId?.length)
            parts.push(`i.item_type_id = ANY(${b.push(f.itemTypeId)})`);
        b.addRaw(`(${parts.join(' AND ')})`);
    }
    return b;
}
/** `TRUE` when the PO-line query needs the items join for a master dimension. */
const needsItemJoin = (f) => Boolean(f.departmentId?.length || f.costCentreId?.length || f.mainGroupId?.length ||
    f.subMainGroupId?.length || f.itemTypeId?.length);
const PO_LINE_FROM = (f) => `FROM v_po_line_balance v${needsItemJoin(f) ? ' JOIN items i ON i.id = v.item_id' : ''}`;
/** Applies the universal filter to an indent-line query (alias `v`). */
function indentLineFilter(f) {
    const b = new SqlBuilder();
    b.addRaw("v.indent_status <> 'CANCELLED'");
    b.add('v.indent_date >= ?', f.dateFrom);
    b.add('v.indent_date <= ?', f.dateTo);
    b.addIn('v.item_id', f.itemId);
    b.addIn('v.department_id', f.departmentId);
    b.addIn('v.cost_centre_id', f.costCentreId);
    b.addIn('v.indent_type_id', f.indentTypeId);
    b.addIn('v.suggested_supplier_id', f.supplierId);
    b.addIn('v.indent_status', f.status);
    b.addIn('v.requested_by_user_id', f.userId);
    return b;
}
/** Indent HEADER filter (alias `h`), for count-based indent metrics. */
function indentHeaderFilter(f) {
    const b = new SqlBuilder();
    b.addRaw("h.status <> 'CANCELLED'");
    b.add('h.indent_date >= ?', f.dateFrom);
    b.add('h.indent_date <= ?', f.dateTo);
    b.addIn('h.department_id', f.departmentId);
    b.addIn('h.cost_centre_id', f.costCentreId);
    b.addIn('h.indent_type_id', f.indentTypeId);
    b.addIn('h.suggested_supplier_id', f.supplierId);
    b.addIn('h.requested_by_user_id', f.userId);
    return b;
}
/** Requisition HEADER filter (alias `h`, joined to `b` = v_requisition_header_balance where needed). */
function requisitionHeaderFilter(f) {
    const b = new SqlBuilder();
    b.addRaw("h.status <> 'CANCELLED'");
    b.add('h.requisition_date >= ?', f.dateFrom);
    b.add('h.requisition_date <= ?', f.dateTo);
    b.addIn('h.department_id', f.departmentId);
    b.addIn('h.cost_centre_id', f.costCentreId);
    b.addIn('h.status', f.status);
    if (f.itemId?.length) {
        const p = b.push(f.itemId);
        b.addRaw(`EXISTS (SELECT 1 FROM requisition_lines l WHERE l.requisition_id = h.id AND l.item_id = ANY(${p}))`);
    }
    return b;
}
const meta = (f, extra = {}) => ({
    filters: Object.fromEntries(Object.entries(f).filter(([, v]) => v !== undefined)),
    generatedAt: new Date().toISOString(),
    ...extra,
});
/* ── GET /analytics/metrics — the metric catalogue (ADR-009) ────────────────── */
router.get('/metrics', requirePermission('dashboard.view'), asyncHandler(async (req, res) => {
    // A user only sees definitions for metrics they are allowed to read.
    const visible = METRICS.filter((m) => req.user.permissions.has(m.permission));
    sendOk(res, {
        metrics: visible,
        ageingBuckets: AGEING_BUCKETS,
    });
}));
/* ── GET /analytics/kpis ────────────────────────────────────────────────────── */
const kpiSchema = universalFilterSchema.extend({
    /** When true, also computes the previous equal-length period for trend arrows. */
    compare: z.enum(['true', 'false']).default('true'),
});
router.get('/kpis', requirePermission('dashboard.view'), validateQuery(kpiSchema), asyncHandler(async (req, res) => {
    const f = parsedQuery(res);
    const can = (code) => req.user.permissions.has(code);
    /* PO-side aggregates — one pass over the filtered line set. */
    const pb = poLineFilter(f);
    const [po] = await query(`SELECT
         COUNT(DISTINCT v.po_id)::int                                          AS po_count,
         COALESCE(SUM(v.amount), 0)                                            AS po_value,
         COALESCE(SUM(v.po_qty), 0)                                            AS po_qty,
         COALESCE(SUM(v.po_qty * v.rate), 0)                                   AS gross_value,
         COALESCE(SUM(v.received_amount), 0)                                   AS received_value,
         COALESCE(SUM(v.received_qty), 0)                                      AS received_qty,
         COALESCE(SUM(v.pending_amount) FILTER (WHERE v.is_receivable), 0)     AS pending_value,
         COALESCE(SUM(v.pending_grn_qty) FILTER (WHERE v.is_receivable), 0)    AS pending_qty,
         COUNT(DISTINCT v.po_id) FILTER (WHERE v.is_receivable)::int           AS pending_po_count,
         COUNT(DISTINCT v.supplier_id)::int                                    AS supplier_count,
         COUNT(DISTINCT v.item_id)::int                                        AS item_count,
         COUNT(*) FILTER (WHERE v.is_receivable
                            AND v.delivery_date IS NOT NULL
                            AND v.delivery_date < CURRENT_DATE)::int           AS overdue_count
       ${PO_LINE_FROM(f)} ${pb.where()}`, pb.params);
    const cb = poLineFilter(f);
    const [completed] = await query(`SELECT COUNT(*)::int AS n FROM v_po_header_balance b
        WHERE b.derived_status = 'COMPLETED'
          AND b.po_id IN (SELECT DISTINCT v.po_id ${PO_LINE_FROM(f)} ${cb.where()})`, cb.params);
    /* Indent-side aggregates. */
    const ib = indentHeaderFilter(f);
    const [indent] = await query(`SELECT
         COUNT(*)::int                                                   AS indent_count,
         COUNT(*) FILTER (WHERE h.status = 'PENDING_APPROVAL')::int      AS pending_approval,
         COUNT(*) FILTER (WHERE h.status = 'APPROVED')::int              AS approved_count,
         COUNT(*) FILTER (WHERE h.status = 'REJECTED')::int              AS rejected_count,
         COALESCE(AVG(EXTRACT(EPOCH FROM (h.approved_at - h.submitted_at)) / 86400)
                  FILTER (WHERE h.approved_at IS NOT NULL AND h.submitted_at IS NOT NULL), 0)
                                                                          AS avg_approval_days
       FROM purchase_indent_headers h ${ib.where()}`, ib.params);
    const ilb = indentLineFilter(f);
    const [indentLines] = await query(`SELECT
         COALESCE(SUM(v.estimated_value), 0)                                        AS indent_value,
         COALESCE(SUM(v.estimated_value) FILTER (WHERE v.indent_status = 'PENDING_APPROVAL'), 0)
                                                                                    AS pending_indent_value,
         COALESCE(SUM(v.pending_qty) FILTER (WHERE v.is_eligible_for_po), 0)        AS eligible_qty,
         COUNT(*) FILTER (WHERE v.is_eligible_for_po)::int                          AS eligible_lines
       FROM v_indent_line_balance v ${ilb.where()}`, ilb.params);
    /* GRN count. */
    const gb = new SqlBuilder();
    gb.addRaw("g.status = 'POSTED'");
    gb.add('g.grn_date >= ?', f.dateFrom);
    gb.add('g.grn_date <= ?', f.dateTo);
    gb.addIn('g.supplier_id', f.supplierId);
    const [grn] = await query(`SELECT COUNT(*)::int AS grn_count FROM grn_headers g ${gb.where()}`, gb.params);
    /* Supplier concentration — top 5 share of the filtered PO value. */
    const sb = poLineFilter(f);
    const topSuppliers = await query(`SELECT v.supplier_id, SUM(v.amount) AS value ${PO_LINE_FROM(f)} ${sb.where()}
        GROUP BY v.supplier_id ORDER BY SUM(v.amount) DESC LIMIT 5`, sb.params);
    const top5Value = topSuppliers.reduce((acc, s) => acc.plus(dec(s.value)), dec(0));
    /* Purchase cycle time: indent submission → first receipt, over indent-sourced POs. */
    const [cycle] = await query(`SELECT COALESCE(AVG(EXTRACT(EPOCH FROM (first_grn - submitted)) / 86400), 0) AS days
         FROM (
           SELECT ih.submitted_at AS submitted, MIN(g.grn_date)::timestamptz AS first_grn
             FROM po_indent_sources pis
             JOIN purchase_indent_headers ih ON ih.id = pis.indent_id
             JOIN purchase_order_lines pol   ON pol.id = pis.po_line_id
             JOIN grn_lines gl               ON gl.po_line_id = pol.id
             JOIN grn_headers g              ON g.id = gl.grn_id AND g.status = 'POSTED'
            WHERE ih.submitted_at IS NOT NULL
              ${f.dateFrom ? 'AND g.grn_date >= $1' : ''}
              ${f.dateTo ? `AND g.grn_date <= $${f.dateFrom ? 2 : 1}` : ''}
            GROUP BY ih.id, ih.submitted_at
         ) t
        WHERE first_grn >= submitted`, [f.dateFrom, f.dateTo].filter((v) => v !== undefined));
    /* Requisition-side aggregates (independent of the PO/Indent purchase chain). */
    const rb = requisitionHeaderFilter(f);
    const [requisition] = await query(`SELECT
         COUNT(*)::int                                                        AS requisition_count,
         COUNT(*) FILTER (WHERE h.status = 'PENDING_APPROVAL')::int           AS pending_hod,
         COUNT(*) FILTER (WHERE b.hod_status = 'APPROVED')::int               AS hod_approved,
         COUNT(*) FILTER (WHERE b.hod_status = 'REJECTED')::int               AS hod_rejected,
         COUNT(*) FILTER (WHERE h.status = 'APPROVED')::int                   AS awaiting_issue,
         COALESCE(SUM(b.total_requested_qty), 0)                             AS requested_qty,
         COALESCE(SUM(b.total_issued_qty), 0)                                AS issued_qty,
         COALESCE(SUM(b.total_pending_qty), 0)                               AS pending_qty,
         COALESCE(SUM(b.total_excess_qty), 0)                                AS excess_qty,
         COALESCE(AVG(EXTRACT(EPOCH FROM (h.hod_decided_at - h.submitted_at)) / 86400)
                  FILTER (WHERE h.hod_decided_at IS NOT NULL AND h.submitted_at IS NOT NULL), 0)
                                                                               AS avg_approval_days
       FROM requisition_headers h
       JOIN v_requisition_header_balance b ON b.requisition_id = h.id
       ${rb.where()}`, rb.params);
    const [requisitionIssues] = await query(`SELECT COUNT(*)::int AS n FROM requisition_issues i
         JOIN requisition_headers h ON h.id = i.requisition_id
        WHERE h.status <> 'CANCELLED'
          ${f.dateFrom ? "AND i.issue_date >= $1" : ''}
          ${f.dateTo ? `AND i.issue_date <= $${f.dateFrom ? 2 : 1}` : ''}`, [f.dateFrom, f.dateTo].filter((v) => v !== undefined));
    /* Previous period for trend arrows. */
    let previous = null;
    if (f.compare === 'true' && f.dateFrom && f.dateTo) {
        const from = new Date(`${f.dateFrom}T00:00:00`);
        const to = new Date(`${f.dateTo}T00:00:00`);
        const span = Math.max(1, Math.round((to.getTime() - from.getTime()) / 86400000) + 1);
        const prevTo = new Date(from.getTime() - 86400000);
        const prevFrom = new Date(prevTo.getTime() - (span - 1) * 86400000);
        const iso = (d) => d.toISOString().slice(0, 10);
        const prevFilter = { ...f, dateFrom: iso(prevFrom), dateTo: iso(prevTo) };
        const ppb = poLineFilter(prevFilter);
        const [prev] = await query(`SELECT COUNT(DISTINCT v.po_id)::int AS po_count,
                COALESCE(SUM(v.amount), 0)   AS po_value,
                COALESCE(SUM(v.po_qty), 0)   AS po_qty,
                COALESCE(SUM(v.received_amount), 0) AS received_value
           ${PO_LINE_FROM(prevFilter)} ${ppb.where()}`, ppb.params);
        previous = prev ?? null;
    }
    const grossValue = dec(po?.gross_value ?? 0);
    const netValue = dec(po?.po_value ?? 0);
    const discountSavings = grossValue.minus(netValue);
    /* Assemble against the catalogue — a KPI is emitted only if it is declared in
       `domain/metrics.ts` AND the caller holds its permission. */
    const values = {
        po_value_total: { value: po?.po_value ?? '0', previous: previous?.po_value ?? null, changePct: previous ? pctChange(po?.po_value ?? 0, previous.po_value ?? 0) : null },
        po_count: { value: Number(po?.po_count ?? 0), previous: previous ? Number(previous.po_count) : null, changePct: previous ? pctChange(po?.po_count ?? 0, previous.po_count ?? 0) : null },
        po_qty_total: { value: po?.po_qty ?? '0', previous: previous?.po_qty ?? null, changePct: previous ? pctChange(po?.po_qty ?? 0, previous.po_qty ?? 0) : null },
        po_avg_value: { value: Number(po?.po_count ?? 0) > 0 ? netValue.div(Number(po.po_count)).toFixed(2) : '0.00' },
        po_pending_value: { value: po?.pending_value ?? '0' },
        po_pending_count: { value: Number(po?.pending_po_count ?? 0) },
        po_completed_count: { value: Number(completed?.n ?? 0) },
        po_overdue_count: { value: Number(po?.overdue_count ?? 0) },
        indent_count: { value: Number(indent?.indent_count ?? 0) },
        indent_pending_approval: { value: Number(indent?.pending_approval ?? 0) },
        indent_pending_value: { value: indentLines?.pending_indent_value ?? '0' },
        indent_approved_open_qty: { value: indentLines?.eligible_qty ?? '0' },
        indent_rejection_rate: {
            value: Number(indent?.approved_count ?? 0) + Number(indent?.rejected_count ?? 0) > 0
                ? shareOf(indent?.rejected_count ?? 0, Number(indent?.approved_count ?? 0) + Number(indent?.rejected_count ?? 0))
                : 0,
        },
        indent_avg_approval_days: { value: dec(indent?.avg_approval_days ?? 0).toDecimalPlaces(1).toNumber() },
        grn_count: { value: Number(grn?.grn_count ?? 0) },
        grn_qty_total: { value: po?.received_qty ?? '0' },
        grn_value_total: { value: po?.received_value ?? '0', previous: previous?.received_value ?? null, changePct: previous ? pctChange(po?.received_value ?? 0, previous.received_value ?? 0) : null },
        grn_pending_qty: { value: po?.pending_qty ?? '0' },
        grn_fulfilment_rate: { value: shareOf(po?.received_qty ?? 0, po?.po_qty ?? 0) },
        purchase_cycle_days: { value: dec(cycle?.days ?? 0).toDecimalPlaces(1).toNumber() },
        avg_discount_pct: { value: grossValue.isZero() ? 0 : shareOf(discountSavings, grossValue) },
        discount_savings: { value: discountSavings.toFixed(2) },
        supplier_count: { value: Number(po?.supplier_count ?? 0) },
        supplier_concentration: { value: shareOf(top5Value, netValue) },
        item_count: { value: Number(po?.item_count ?? 0) },
        requisition_count: { value: Number(requisition?.requisition_count ?? 0) },
        requisition_pending_hod: { value: Number(requisition?.pending_hod ?? 0) },
        requisition_hod_approved: { value: Number(requisition?.hod_approved ?? 0) },
        requisition_hod_rejected: { value: Number(requisition?.hod_rejected ?? 0) },
        requisition_awaiting_issue: { value: Number(requisition?.awaiting_issue ?? 0) },
        requisition_requested_qty: { value: requisition?.requested_qty ?? '0' },
        requisition_issued_qty: { value: requisition?.issued_qty ?? '0' },
        requisition_pending_qty: { value: requisition?.pending_qty ?? '0' },
        requisition_excess_qty: { value: requisition?.excess_qty ?? '0' },
        requisition_avg_approval_days: { value: dec(requisition?.avg_approval_days ?? 0).toDecimalPlaces(1).toNumber() },
        requisition_issue_transaction_count: { value: Number(requisitionIssues?.n ?? 0) },
    };
    const kpis = METRICS
        .filter((m) => can(m.permission) && values[m.key] !== undefined)
        .map((m) => ({ ...m, ...values[m.key] }));
    sendOk(res, { kpis }, meta(f));
}));
/* ── GET /analytics/trends ──────────────────────────────────────────────────── */
const trendSchema = universalFilterSchema.extend({
    granularity: z.enum(['day', 'week', 'month', 'quarter', 'year']).default('month'),
    series: z.enum(['po', 'indent', 'grn', 'all']).default('all'),
});
const TRUNC = {
    day: 'day', week: 'week', month: 'month', quarter: 'quarter', year: 'year',
};
router.get('/trends', requireAnyPermission('dashboard.analyze', 'po.analyze', 'indent.analyze', 'grn.analyze', 'requisition.analyze'), validateQuery(trendSchema), asyncHandler(async (_req, res) => {
    const f = parsedQuery(res);
    const bucket = TRUNC[f.granularity];
    const pb = poLineFilter(f);
    const poSeries = await query(`SELECT to_char(date_trunc('${bucket}', v.po_date), 'YYYY-MM-DD') AS period,
              COUNT(DISTINCT v.po_id)::int      AS po_count,
              SUM(v.amount)                     AS po_value,
              SUM(v.po_qty)                     AS po_qty,
              SUM(v.received_amount)            AS received_value,
              SUM(v.pending_amount) FILTER (WHERE v.is_receivable) AS pending_value
         ${PO_LINE_FROM(f)} ${pb.where()}
        GROUP BY 1 ORDER BY 1`, pb.params);
    const ib = indentHeaderFilter(f);
    const indentSeries = await query(`SELECT to_char(date_trunc('${bucket}', h.indent_date), 'YYYY-MM-DD') AS period,
              COUNT(*)::int                                            AS indent_count,
              COUNT(*) FILTER (WHERE h.status = 'APPROVED')::int        AS approved_count,
              COUNT(*) FILTER (WHERE h.status = 'REJECTED')::int        AS rejected_count,
              COUNT(*) FILTER (WHERE h.status = 'PENDING_APPROVAL')::int AS pending_count
         FROM purchase_indent_headers h ${ib.where()}
        GROUP BY 1 ORDER BY 1`, ib.params);
    const gb = new SqlBuilder();
    gb.addRaw("g.status = 'POSTED'");
    gb.add('g.grn_date >= ?', f.dateFrom);
    gb.add('g.grn_date <= ?', f.dateTo);
    gb.addIn('g.supplier_id', f.supplierId);
    const grnSeries = await query(`SELECT to_char(date_trunc('${bucket}', g.grn_date), 'YYYY-MM-DD') AS period,
              COUNT(DISTINCT g.id)::int AS grn_count,
              SUM(gl.grn_qty)           AS grn_qty,
              SUM(gl.amount)            AS grn_value
         FROM grn_headers g JOIN grn_lines gl ON gl.grn_id = g.id
         ${gb.where()}
        GROUP BY 1 ORDER BY 1`, gb.params);
    const rb = requisitionHeaderFilter(f);
    const requisitionSeries = await query(`SELECT to_char(date_trunc('${bucket}', h.requisition_date), 'YYYY-MM-DD') AS period,
              COUNT(*)::int                                             AS requisition_count,
              COALESCE(SUM(b.total_requested_qty), 0)                   AS requested_qty,
              COALESCE(SUM(b.total_issued_qty), 0)                      AS issued_qty,
              COUNT(*) FILTER (WHERE b.hod_status = 'APPROVED')::int    AS approved_count,
              COUNT(*) FILTER (WHERE b.hod_status = 'REJECTED')::int    AS rejected_count,
              COUNT(*) FILTER (WHERE h.status = 'PENDING_APPROVAL')::int AS pending_count
         FROM requisition_headers h JOIN v_requisition_header_balance b ON b.requisition_id = h.id
         ${rb.where()}
        GROUP BY 1 ORDER BY 1`, rb.params);
    // Merge into one dense series so the chart has no gaps.
    const periods = [...new Set([
            ...poSeries.map((r) => r.period),
            ...indentSeries.map((r) => r.period),
            ...grnSeries.map((r) => r.period),
            ...requisitionSeries.map((r) => r.period),
        ])].sort();
    const poMap = new Map(poSeries.map((r) => [r.period, r]));
    const inMap = new Map(indentSeries.map((r) => [r.period, r]));
    const grMap = new Map(grnSeries.map((r) => [r.period, r]));
    const reqMap = new Map(requisitionSeries.map((r) => [r.period, r]));
    const data = periods.map((p) => ({
        period: p,
        poCount: Number(poMap.get(p)?.po_count ?? 0),
        poValue: String(poMap.get(p)?.po_value ?? '0'),
        poQty: String(poMap.get(p)?.po_qty ?? '0'),
        receivedValue: String(poMap.get(p)?.received_value ?? '0'),
        pendingValue: String(poMap.get(p)?.pending_value ?? '0'),
        indentCount: Number(inMap.get(p)?.indent_count ?? 0),
        approvedCount: Number(inMap.get(p)?.approved_count ?? 0),
        rejectedCount: Number(inMap.get(p)?.rejected_count ?? 0),
        pendingCount: Number(inMap.get(p)?.pending_count ?? 0),
        grnCount: Number(grMap.get(p)?.grn_count ?? 0),
        grnQty: String(grMap.get(p)?.grn_qty ?? '0'),
        grnValue: String(grMap.get(p)?.grn_value ?? '0'),
        requisitionCount: Number(reqMap.get(p)?.requisition_count ?? 0),
        requisitionRequestedQty: String(reqMap.get(p)?.requested_qty ?? '0'),
        requisitionIssuedQty: String(reqMap.get(p)?.issued_qty ?? '0'),
        requisitionApprovedCount: Number(reqMap.get(p)?.approved_count ?? 0),
        requisitionRejectedCount: Number(reqMap.get(p)?.rejected_count ?? 0),
        requisitionPendingCount: Number(reqMap.get(p)?.pending_count ?? 0),
    }));
    sendOk(res, data, meta(f, { granularity: f.granularity }));
}));
/* ── GET /analytics/breakdown/:dimension ────────────────────────────────────── */
/** Server-controlled dimension map — the ONLY place a group-by column is chosen. */
const DIMENSIONS = {
    supplier: {
        id: 'v.supplier_id', label: 's.supplier_name',
        join: 'JOIN suppliers s ON s.id = v.supplier_id',
        title: 'Supplier', drill: 'supplierId',
    },
    item: {
        id: 'v.item_id', label: "v.item_code || ' — ' || v.item_description",
        join: '', title: 'Item', drill: 'itemId',
    },
    department: {
        id: 'i.department_id', label: "COALESCE(d.name, 'Unassigned')",
        join: 'JOIN items i ON i.id = v.item_id LEFT JOIN lookups d ON d.id = i.department_id',
        title: 'Department', drill: 'departmentId',
    },
    costCentre: {
        id: 'i.cost_centre_id', label: "COALESCE(cc.name, 'Unassigned')",
        join: 'JOIN items i ON i.id = v.item_id LEFT JOIN lookups cc ON cc.id = i.cost_centre_id',
        title: 'Cost Centre', drill: 'costCentreId',
    },
    mainGroup: {
        id: 'i.main_group_id', label: "COALESCE(mg.name, 'Ungrouped')",
        join: 'JOIN items i ON i.id = v.item_id LEFT JOIN lookups mg ON mg.id = i.main_group_id',
        title: 'Main Group', drill: 'mainGroupId',
    },
    subMainGroup: {
        id: 'i.sub_main_group_id', label: "COALESCE(smg.name, 'Ungrouped')",
        join: 'JOIN items i ON i.id = v.item_id LEFT JOIN lookups smg ON smg.id = i.sub_main_group_id',
        title: 'Sub Main Group', drill: 'subMainGroupId',
    },
    itemType: {
        id: 'i.item_type_id', label: "COALESCE(it.name, 'Unclassified')",
        join: 'JOIN items i ON i.id = v.item_id LEFT JOIN lookups it ON it.id = i.item_type_id',
        title: 'Item Type', drill: 'itemTypeId',
    },
    poType: {
        id: 'v.po_type_id', label: "COALESCE(pt.name, 'Unspecified')",
        join: 'LEFT JOIN lookups pt ON pt.id = v.po_type_id',
        title: 'PO Type', drill: 'poTypeId',
    },
    status: {
        id: 'v.po_status', label: 'v.po_status',
        join: '', title: 'Status', drill: 'status',
    },
};
const breakdownSchema = universalFilterSchema.extend({
    limit: z.coerce.number().int().min(1).max(100).default(15),
    sortBy: z.enum(['value', 'qty', 'count', 'pending']).default('value'),
});
router.get('/breakdown/:dimension', requireAnyPermission('dashboard.analyze', 'po.analyze'), validateQuery(breakdownSchema), asyncHandler(async (req, res) => {
    const key = req.params.dimension ?? '';
    const dim = DIMENSIONS[key];
    if (!dim) {
        throw ValidationError(`Unknown analysis dimension "${key}".`, [{ field: 'dimension', message: `Supported: ${Object.keys(DIMENSIONS).join(', ')}.` }]);
    }
    const f = parsedQuery(res);
    // The dimension's own join may already provide `items`; avoid joining twice.
    const dimJoinsItems = dim.join.includes('JOIN items i');
    const b = poLineFilter(f);
    const from = `FROM v_po_line_balance v ${dim.join}${!dimJoinsItems && needsItemJoin(f) ? ' JOIN items i ON i.id = v.item_id' : ''}`;
    const sortColumn = {
        value: 'SUM(v.amount)', qty: 'SUM(v.po_qty)',
        count: 'COUNT(DISTINCT v.po_id)', pending: 'SUM(v.pending_amount)',
    }[f.sortBy];
    const limit = b.push(f.limit);
    const rows = await query(`SELECT ${dim.id}::text                     AS key,
              ${dim.label}                        AS label,
              COUNT(DISTINCT v.po_id)::int        AS po_count,
              COUNT(*)::int                       AS line_count,
              SUM(v.po_qty)                       AS total_qty,
              SUM(v.amount)                       AS total_value,
              SUM(v.received_qty)                 AS received_qty,
              SUM(v.received_amount)              AS received_value,
              SUM(v.pending_grn_qty) FILTER (WHERE v.is_receivable) AS pending_qty,
              SUM(v.pending_amount)  FILTER (WHERE v.is_receivable) AS pending_value,
              AVG(v.final_rate)                   AS avg_rate,
              AVG(v.discount_pct)                 AS avg_discount
         ${from} ${b.where()}
        GROUP BY ${dim.id}, ${dim.label}
        ORDER BY ${sortColumn} DESC NULLS LAST
        LIMIT ${limit}`, b.params);
    // Grand total over the SAME filter, so shares add up honestly even when the
    // list is truncated to `limit`.
    const tb = poLineFilter(f);
    const [totals] = await query(`SELECT SUM(v.amount) AS total_value, SUM(v.po_qty) AS total_qty,
              COUNT(DISTINCT v.po_id)::int AS po_count, COUNT(DISTINCT ${dim.id})::int AS group_count
         FROM v_po_line_balance v ${dim.join}${!dimJoinsItems && needsItemJoin(f) ? ' JOIN items i ON i.id = v.item_id' : ''}
         ${tb.where()}`, tb.params);
    const grandTotal = totals?.total_value ?? '0';
    const data = rows.map((r) => ({
        key: r.key,
        label: r.label,
        poCount: Number(r.po_count),
        lineCount: Number(r.line_count),
        totalQty: r.total_qty ?? '0',
        totalValue: r.total_value ?? '0',
        receivedQty: r.received_qty ?? '0',
        receivedValue: r.received_value ?? '0',
        pendingQty: r.pending_qty ?? '0',
        pendingValue: r.pending_value ?? '0',
        avgRate: r.avg_rate ?? '0',
        avgDiscount: r.avg_discount ?? '0',
        sharePct: shareOf(r.total_value ?? 0, grandTotal),
    }));
    sendOk(res, data, meta(f, {
        dimension: key,
        dimensionTitle: dim.title,
        drilldownParam: dim.drill,
        grandTotalValue: grandTotal,
        grandTotalQty: totals?.total_qty ?? '0',
        groupCount: Number(totals?.group_count ?? 0),
        shown: data.length,
        truncated: Number(totals?.group_count ?? 0) > data.length,
    }));
}));
/* ── GET /analytics/requisition-breakdown/:dimension ─────────────────────────
   Requisition has NO monetary value (it is a material request, not a purchase
   document — Rate is informational only), so this is a SEPARATE endpoint from
   /breakdown/:dimension rather than forcing quantity-only data through the
   PO's money-shaped (Value/Received/Pending ₹) response contract. Same
   architecture — server-controlled dimension map, one query, a grand total
   computed over the same filter — just a quantity vocabulary instead of a
   currency one. */
const REQUISITION_DIMENSIONS = {
    item: {
        id: 'l.item_id', label: "l.item_code || ' — ' || l.item_description",
        join: 'JOIN requisition_lines l ON l.requisition_id = h.id', title: 'Item', drill: 'itemId',
    },
    department: {
        id: 'h.department_id', label: "COALESCE(h.department_name, 'Unassigned')",
        join: '', title: 'Department', drill: 'departmentId',
    },
    requester: {
        id: 'h.requester_user_id', label: "COALESCE(h.employee_name, 'Unknown')",
        join: '', title: 'Requester', drill: 'requesterId',
    },
    hod: {
        id: 'h.hod_user_id', label: "COALESCE(h.hod_name, 'Unassigned')",
        join: '', title: 'HOD', drill: 'hodId',
    },
    machine: {
        id: 'h.machine_id', label: "COALESCE(m.name, 'Unspecified')",
        join: 'LEFT JOIN lookups m ON m.id = h.machine_id', title: 'Machine', drill: 'machineId',
    },
    costCentre: {
        id: 'h.cost_centre_id', label: "COALESCE(cc.name, 'Unspecified')",
        join: 'LEFT JOIN lookups cc ON cc.id = h.cost_centre_id', title: 'Cost Centre', drill: 'costCentreId',
    },
};
const requisitionBreakdownSchema = universalFilterSchema.extend({
    limit: z.coerce.number().int().min(1).max(100).default(15),
    sortBy: z.enum(['requestedQty', 'issuedQty', 'count', 'pending']).default('requestedQty'),
});
router.get('/requisition-breakdown/:dimension', requireAnyPermission('dashboard.analyze', 'requisition.analyze'), validateQuery(requisitionBreakdownSchema), asyncHandler(async (req, res) => {
    const key = req.params.dimension ?? '';
    const dim = REQUISITION_DIMENSIONS[key];
    if (!dim) {
        throw ValidationError(`Unknown requisition analysis dimension "${key}".`, [{ field: 'dimension', message: `Supported: ${Object.keys(REQUISITION_DIMENSIONS).join(', ')}.` }]);
    }
    const f = parsedQuery(res);
    const b = requisitionHeaderFilter(f);
    const from = `FROM requisition_headers h JOIN v_requisition_header_balance bal ON bal.requisition_id = h.id ${dim.join}`;
    const sortColumn = {
        requestedQty: 'SUM(bal.total_requested_qty)', issuedQty: 'SUM(bal.total_issued_qty)',
        count: 'COUNT(DISTINCT h.id)', pending: 'SUM(bal.total_pending_qty)',
    }[f.sortBy];
    const limit = b.push(f.limit);
    const rows = await query(`SELECT ${dim.id}::text                        AS key,
              ${dim.label}                            AS label,
              COUNT(DISTINCT h.id)::int                AS requisition_count,
              SUM(bal.total_requested_qty)             AS total_requested_qty,
              SUM(bal.total_issued_qty)                AS total_issued_qty,
              SUM(bal.total_pending_qty)                AS total_pending_qty,
              SUM(bal.total_excess_qty)                 AS total_excess_qty
         ${from} ${b.where()}
        GROUP BY ${dim.id}, ${dim.label}
        ORDER BY ${sortColumn} DESC NULLS LAST
        LIMIT ${limit}`, b.params);
    const tb = requisitionHeaderFilter(f);
    const [totals] = await query(`SELECT SUM(bal.total_requested_qty) AS total_requested_qty, COUNT(DISTINCT h.id)::int AS requisition_count,
              COUNT(DISTINCT ${dim.id})::int AS group_count
         FROM requisition_headers h JOIN v_requisition_header_balance bal ON bal.requisition_id = h.id ${dim.join}
         ${tb.where()}`, tb.params);
    const grandTotalQty = totals?.total_requested_qty ?? '0';
    const data = rows.map((r) => ({
        key: r.key,
        label: r.label,
        requisitionCount: Number(r.requisition_count),
        totalRequestedQty: r.total_requested_qty ?? '0',
        totalIssuedQty: r.total_issued_qty ?? '0',
        totalPendingQty: r.total_pending_qty ?? '0',
        totalExcessQty: r.total_excess_qty ?? '0',
        sharePct: shareOf(r.total_requested_qty ?? 0, grandTotalQty),
    }));
    sendOk(res, data, meta(f, {
        dimension: key,
        dimensionTitle: dim.title,
        drilldownParam: dim.drill,
        grandTotalRequestedQty: grandTotalQty,
        requisitionCount: Number(totals?.requisition_count ?? 0),
        groupCount: Number(totals?.group_count ?? 0),
        shown: data.length,
        truncated: Number(totals?.group_count ?? 0) > data.length,
    }));
}));
/* ── GET /analytics/ageing ──────────────────────────────────────────────────── */
const ageingSchema = universalFilterSchema.extend({
    basis: z.enum(['po', 'indent', 'requisition']).default('po'),
});
router.get('/ageing', requireAnyPermission('dashboard.analyze', 'po.analyze', 'indent.analyze', 'requisition.analyze'), validateQuery(ageingSchema), asyncHandler(async (_req, res) => {
    const f = parsedQuery(res);
    if (f.basis === 'requisition') {
        // HOD-approved but not yet fully issued — Store Status still PENDING —
        // aged by how long it has sat in the store queue.
        const b = requisitionHeaderFilter(f);
        b.addRaw("h.status IN ('APPROVED','PARTIALLY_ISSUED')");
        const rows = await query(`SELECT ${ageingCase('(CURRENT_DATE - h.requisition_date)::int')} AS bucket,
                COUNT(*)::int                          AS line_count,
                COUNT(DISTINCT h.id)::int               AS doc_count,
                SUM(bal.total_pending_qty)              AS pending_qty
           FROM requisition_headers h
           JOIN v_requisition_header_balance bal ON bal.requisition_id = h.id
           ${b.where()}
          GROUP BY 1`, b.params);
        const map = new Map(rows.map((r) => [r.bucket, r]));
        sendOk(res, AGEING_BUCKETS.map((bk) => ({
            bucket: bk.key, label: bk.label,
            lineCount: Number(map.get(bk.key)?.line_count ?? 0),
            docCount: Number(map.get(bk.key)?.doc_count ?? 0),
            pendingQty: map.get(bk.key)?.pending_qty ?? '0',
            pendingValue: '0',
        })), meta(f, { basis: 'requisition', title: 'HOD-approved requisitions awaiting store issue' }));
        return;
    }
    if (f.basis === 'indent') {
        const b = indentLineFilter(f);
        b.addRaw('v.is_eligible_for_po = TRUE');
        const rows = await query(`SELECT ${ageingCase('(CURRENT_DATE - v.indent_date)::int')} AS bucket,
                COUNT(*)::int                  AS line_count,
                COUNT(DISTINCT v.indent_id)::int AS doc_count,
                SUM(v.pending_qty)             AS pending_qty,
                SUM(v.pending_qty * COALESCE(v.estimated_rate, 0)) AS pending_value
           FROM v_indent_line_balance v ${b.where()}
          GROUP BY 1`, b.params);
        const map = new Map(rows.map((r) => [r.bucket, r]));
        sendOk(res, AGEING_BUCKETS.map((bk) => ({
            bucket: bk.key, label: bk.label,
            lineCount: Number(map.get(bk.key)?.line_count ?? 0),
            docCount: Number(map.get(bk.key)?.doc_count ?? 0),
            pendingQty: map.get(bk.key)?.pending_qty ?? '0',
            pendingValue: map.get(bk.key)?.pending_value ?? '0',
        })), meta(f, { basis: 'indent', title: 'Approved indent quantity awaiting purchase order' }));
        return;
    }
    const b = poLineFilter(f);
    b.addRaw('v.is_receivable = TRUE');
    const rows = await query(`SELECT ${ageingCase('(CURRENT_DATE - v.po_date)::int')} AS bucket,
              COUNT(*)::int                AS line_count,
              COUNT(DISTINCT v.po_id)::int AS doc_count,
              SUM(v.pending_grn_qty)       AS pending_qty,
              SUM(v.pending_amount)        AS pending_value
         ${PO_LINE_FROM(f)} ${b.where()}
        GROUP BY 1`, b.params);
    const map = new Map(rows.map((r) => [r.bucket, r]));
    sendOk(res, AGEING_BUCKETS.map((bk) => ({
        bucket: bk.key, label: bk.label,
        lineCount: Number(map.get(bk.key)?.line_count ?? 0),
        docCount: Number(map.get(bk.key)?.doc_count ?? 0),
        pendingQty: map.get(bk.key)?.pending_qty ?? '0',
        pendingValue: map.get(bk.key)?.pending_value ?? '0',
    })), meta(f, { basis: 'po', title: 'Ordered quantity awaiting goods receipt' }));
}));
/* ── GET /analytics/supplier-performance ────────────────────────────────────── */
router.get('/supplier-performance', requireAnyPermission('dashboard.analyze', 'po.analyze'), validateQuery(universalFilterSchema.extend({ limit: z.coerce.number().int().min(1).max(50).default(20) })), asyncHandler(async (_req, res) => {
    const f = parsedQuery(res);
    const b = poLineFilter(f);
    const limit = b.push(f.limit);
    const rows = await query(`SELECT v.supplier_id::text AS key, s.supplier_name AS label,
              s.city, s.state,
              COUNT(DISTINCT v.po_id)::int  AS po_count,
              SUM(v.amount)                 AS total_value,
              SUM(v.po_qty)                 AS ordered_qty,
              SUM(v.received_qty)           AS received_qty,
              SUM(v.pending_amount) FILTER (WHERE v.is_receivable) AS pending_value,
              AVG(v.discount_pct)           AS avg_discount,
              COUNT(*) FILTER (WHERE v.is_receivable
                                 AND v.delivery_date IS NOT NULL
                                 AND v.delivery_date < CURRENT_DATE)::int AS overdue_lines,
              COUNT(*)::int                 AS total_lines,
              MAX(v.po_date)                AS last_po_date
         FROM v_po_line_balance v
         JOIN suppliers s ON s.id = v.supplier_id
         ${needsItemJoin(f) ? 'JOIN items i ON i.id = v.item_id' : ''}
         ${b.where()}
        GROUP BY v.supplier_id, s.supplier_name, s.city, s.state
        ORDER BY SUM(v.amount) DESC
        LIMIT ${limit}`, b.params);
    const data = rows.map((r) => ({
        key: r.key,
        label: r.label,
        city: r.city,
        state: r.state,
        poCount: Number(r.po_count),
        totalValue: r.total_value ?? '0',
        orderedQty: r.ordered_qty ?? '0',
        receivedQty: r.received_qty ?? '0',
        pendingValue: r.pending_value ?? '0',
        avgDiscount: dec(r.avg_discount ?? 0).toDecimalPlaces(2).toNumber(),
        // Fulfilment: how much of what was ordered has actually arrived.
        fulfilmentRate: shareOf(r.received_qty ?? 0, r.ordered_qty ?? 0),
        // On-time: share of open lines NOT past their promised delivery date.
        onTimeRate: Number(r.total_lines) > 0
            ? Number((100 - shareOf(r.overdue_lines ?? 0, r.total_lines)).toFixed(2))
            : 100,
        overdueLines: Number(r.overdue_lines),
        lastPoDate: r.last_po_date,
    }));
    sendOk(res, data, meta(f));
}));
/* ── GET /analytics/exceptions ──────────────────────────────────────────────── */
/* Things management should look at, each with a drill-down target (SRS §13).    */
router.get('/exceptions', requirePermission('dashboard.analyze'), validateQuery(universalFilterSchema), asyncHandler(async (_req, res) => {
    const f = parsedQuery(res);
    const [overdue] = await query(`SELECT COUNT(*)::int AS n, COALESCE(SUM(pending_amount), 0) AS value
         FROM v_po_line_balance
        WHERE is_receivable AND delivery_date IS NOT NULL AND delivery_date < CURRENT_DATE`);
    const [stale] = await query(`SELECT COUNT(*)::int AS n, COALESCE(SUM(pending_amount), 0) AS value
         FROM v_po_line_balance
        WHERE is_receivable AND (CURRENT_DATE - po_date) > 60`);
    const [oldPending] = await query(`SELECT COUNT(*)::int AS n FROM purchase_indent_headers
        WHERE status = 'PENDING_APPROVAL' AND (CURRENT_DATE - indent_date) > 7`);
    const [unordered] = await query(`SELECT COUNT(DISTINCT indent_id)::int AS n, COALESCE(SUM(pending_qty * COALESCE(estimated_rate,0)), 0) AS value
         FROM v_indent_line_balance
        WHERE is_eligible_for_po AND (CURRENT_DATE - indent_date) > 30`);
    const [draftPo] = await query(`SELECT COUNT(*)::int AS n FROM purchase_order_headers
        WHERE status = 'DRAFT' AND (CURRENT_DATE - po_date) > 3`);
    const [draftGrn] = await query(`SELECT COUNT(*)::int AS n FROM grn_headers
        WHERE status = 'DRAFT' AND (CURRENT_DATE - grn_date) > 2`);
    // A genuine data-integrity alarm: persisted status disagreeing with receipts.
    const [statusDrift] = await query(`SELECT COUNT(*)::int AS n FROM v_po_header_balance WHERE status <> derived_status`);
    const [reqPending] = await query(`SELECT COUNT(*)::int AS n FROM requisition_headers
        WHERE status = 'PENDING_APPROVAL' AND (CURRENT_DATE - requisition_date) > 7`);
    const [reqAwaitingIssue] = await query(`SELECT COUNT(*)::int AS n FROM requisition_headers
        WHERE status IN ('APPROVED','PARTIALLY_ISSUED') AND (CURRENT_DATE - requisition_date) > 14`);
    const [rateSpike] = await query(`SELECT COUNT(*)::int AS n FROM (
         SELECT v.item_id, MIN(v.final_rate) AS lo, MAX(v.final_rate) AS hi
           FROM v_po_line_balance v
          WHERE v.po_status <> 'CANCELLED' AND v.po_date >= CURRENT_DATE - 180
          GROUP BY v.item_id
         HAVING MIN(v.final_rate) > 0 AND MAX(v.final_rate) > MIN(v.final_rate) * 1.25
       ) t`);
    sendOk(res, [
        { key: 'overdue_deliveries', label: 'Overdue deliveries', count: Number(overdue?.n ?? 0), value: overdue?.value ?? '0', severity: 'high', description: 'Purchase order lines past their promised delivery date with quantity outstanding.', drilldown: '/purchase-orders/pending?overdue=true' },
        { key: 'stale_pos', label: 'Purchase orders open over 60 days', count: Number(stale?.n ?? 0), value: stale?.value ?? '0', severity: 'high', description: 'Long-outstanding commitments that may never be delivered.', drilldown: '/purchase-orders/pending' },
        { key: 'ageing_approvals', label: 'Indents awaiting approval over 7 days', count: Number(oldPending?.n ?? 0), value: null, severity: 'medium', description: 'Requisitions blocked at the approval step.', drilldown: '/indents?status=PENDING_APPROVAL' },
        { key: 'unordered_indents', label: 'Approved indents unordered over 30 days', count: Number(unordered?.n ?? 0), value: unordered?.value ?? '0', severity: 'medium', description: 'Approved demand that has not been converted into a purchase order.', drilldown: '/indents?status=APPROVED' },
        { key: 'stale_draft_pos', label: 'Draft purchase orders over 3 days old', count: Number(draftPo?.n ?? 0), value: null, severity: 'low', description: 'Unissued drafts holding indent quantity in reserve.', drilldown: '/purchase-orders?status=DRAFT' },
        { key: 'stale_draft_grns', label: 'Unposted GRNs over 2 days old', count: Number(draftGrn?.n ?? 0), value: null, severity: 'medium', description: 'Received goods not yet reflected in purchase order balances.', drilldown: '/grn?status=DRAFT' },
        { key: 'rate_variance', label: 'Items with over 25% rate variance', count: Number(rateSpike?.n ?? 0), value: null, severity: 'low', description: 'Items whose purchase rate has moved sharply in the last 180 days.', drilldown: '/masters/items' },
        { key: 'status_drift', label: 'Documents with inconsistent status', count: Number(statusDrift?.n ?? 0), value: null, severity: Number(statusDrift?.n ?? 0) > 0 ? 'high' : 'low', description: 'Purchase orders whose stored status disagrees with their receipts. Expected to be zero.', drilldown: '/purchase-orders' },
        { key: 'requisition_pending_hod', label: 'Requisitions awaiting HOD approval over 7 days', count: Number(reqPending?.n ?? 0), value: null, severity: 'medium', description: 'Material requisitions blocked at the HOD approval step.', drilldown: '/requisitions?status=PENDING_APPROVAL' },
        { key: 'requisition_awaiting_issue', label: 'Approved requisitions awaiting store issue over 14 days', count: Number(reqAwaitingIssue?.n ?? 0), value: null, severity: 'medium', description: 'HOD-approved requisitions Store has not yet acted on.', drilldown: '/requisitions/store-queue' },
    ], meta(f));
}));
/* ── GET /analytics/top-movers ──────────────────────────────────────────────── */
router.get('/top-movers', requireAnyPermission('dashboard.analyze', 'po.analyze'), validateQuery(universalFilterSchema.extend({ limit: z.coerce.number().int().min(1).max(20).default(5) })), asyncHandler(async (_req, res) => {
    const f = parsedQuery(res);
    const topB = poLineFilter(f);
    const topLimit = topB.push(f.limit);
    const topItems = await query(`SELECT v.item_id::text AS key, v.item_code, v.item_description AS label,
              SUM(v.amount) AS total_value, SUM(v.po_qty) AS total_qty,
              COUNT(DISTINCT v.po_id)::int AS po_count
         ${PO_LINE_FROM(f)} ${topB.where()}
        GROUP BY v.item_id, v.item_code, v.item_description
        ORDER BY SUM(v.amount) DESC LIMIT ${topLimit}`, topB.params);
    const botB = poLineFilter(f);
    const botLimit = botB.push(f.limit);
    const bottomItems = await query(`SELECT v.item_id::text AS key, v.item_code, v.item_description AS label,
              SUM(v.amount) AS total_value, SUM(v.po_qty) AS total_qty,
              COUNT(DISTINCT v.po_id)::int AS po_count
         ${PO_LINE_FROM(f)} ${botB.where()}
        GROUP BY v.item_id, v.item_code, v.item_description
        ORDER BY SUM(v.amount) ASC LIMIT ${botLimit}`, botB.params);
    const supB = poLineFilter(f);
    const supLimit = supB.push(f.limit);
    const topSuppliers = await query(`SELECT v.supplier_id::text AS key, s.supplier_name AS label,
              SUM(v.amount) AS total_value, COUNT(DISTINCT v.po_id)::int AS po_count
         FROM v_po_line_balance v JOIN suppliers s ON s.id = v.supplier_id
         ${needsItemJoin(f) ? 'JOIN items i ON i.id = v.item_id' : ''}
         ${supB.where()}
        GROUP BY v.supplier_id, s.supplier_name
        ORDER BY SUM(v.amount) DESC LIMIT ${supLimit}`, supB.params);
    sendOk(res, { topItems, bottomItems, topSuppliers }, meta(f));
}));
export default router;
//# sourceMappingURL=routes.js.map