import { z } from 'zod';
import { AppError, ValidationError } from './errors.js';
export function sendOk(res, data, meta) {
    return res.json({ success: true, data, ...(meta ? { meta } : {}) });
}
export function sendCreated(res, data, meta) {
    return res.status(201).json({ success: true, data, ...(meta ? { meta } : {}) });
}
export function sendPage(res, rows, total, page, pageSize, extra) {
    const totalPages = pageSize > 0 ? Math.ceil(total / pageSize) : 0;
    const meta = {
        page,
        pageSize,
        total,
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1,
        ...extra,
    };
    return res.json({ success: true, data: rows, meta });
}
/** Wraps an async route so a rejected promise reaches the error middleware. */
export function asyncHandler(fn) {
    return (req, res, next) => {
        void Promise.resolve(fn(req, res, next)).catch(next);
    };
}
/* ── Validation ─────────────────────────────────────────────────────────────── */
function zodIssues(err) {
    return err.issues.map((i) => ({
        field: i.path.join('.') || '(root)',
        message: i.message,
    }));
}
/** Parses and REPLACES `req.body` with the validated value. */
export function validateBody(schema) {
    return (req, _res, next) => {
        const result = schema.safeParse(req.body);
        if (!result.success) {
            next(ValidationError('Please correct the highlighted fields.', zodIssues(result.error)));
            return;
        }
        req.body = result.data;
        next();
    };
}
/** Parses query params, storing the result on `res.locals.query`. */
export function validateQuery(schema) {
    return (req, res, next) => {
        const result = schema.safeParse(req.query);
        if (!result.success) {
            next(ValidationError('Invalid query parameters.', zodIssues(result.error)));
            return;
        }
        res.locals.query = result.data;
        next();
    };
}
export function parsedQuery(res) {
    return res.locals.query;
}
/** Validated positive integer route parameter. */
export function idParam(req, name = 'id') {
    const raw = req.params[name];
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) {
        throw ValidationError(`Invalid ${name} in URL.`, [{ field: name, message: 'Must be a positive integer.' }]);
    }
    return n;
}
/* ── List query standard (SRS §21, §30) ─────────────────────────────────────── */
export const MAX_PAGE_SIZE = 200;
/** Shared pagination/sort/search params. Every list endpoint extends this. */
export const listQuerySchema = z.object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(25),
    search: z.string().trim().max(200).optional(),
    sortBy: z.string().trim().max(60).optional(),
    sortDir: z.enum(['asc', 'desc']).default('desc'),
});
/**
 * Resolves a client-supplied sort field against an allow-list.
 *
 * Sort columns can never be parameterised in SQL, so they MUST come from a
 * server-controlled map — this is the only safe way to build ORDER BY and is the
 * single place in the codebase where a column name is interpolated.
 */
export function resolveSort(query, allowed, fallback) {
    const column = (query.sortBy && allowed[query.sortBy]) || allowed[fallback] || fallback;
    const dir = query.sortDir === 'asc' ? 'ASC' : 'DESC';
    return `${column} ${dir}`;
}
export function offsetOf(query) {
    return (query.page - 1) * query.pageSize;
}
/** Comma-separated query value → string array (e.g. `?status=OPEN,COMPLETED`). */
export const csvArray = z
    .union([z.string(), z.array(z.string())])
    .optional()
    .transform((v) => {
    if (v === undefined)
        return undefined;
    const list = Array.isArray(v) ? v : v.split(',');
    const cleaned = list.map((s) => s.trim()).filter((s) => s.length > 0);
    return cleaned.length > 0 ? cleaned : undefined;
});
/** Comma-separated numeric ids. */
export const csvIdArray = z
    .union([z.string(), z.array(z.string())])
    .optional()
    .transform((v) => {
    if (v === undefined)
        return undefined;
    const list = Array.isArray(v) ? v : v.split(',');
    const nums = list.map((s) => Number(String(s).trim())).filter((n) => Number.isInteger(n) && n > 0);
    return nums.length > 0 ? nums : undefined;
});
/** Universal filter dimensions shared by lists and analytics (SRS §14). */
export const universalFilterSchema = z.object({
    dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    supplierId: csvIdArray,
    itemId: csvIdArray,
    departmentId: csvIdArray,
    costCentreId: csvIdArray,
    indentTypeId: csvIdArray,
    poTypeId: csvIdArray,
    mainGroupId: csvIdArray,
    subMainGroupId: csvIdArray,
    itemTypeId: csvIdArray,
    userId: csvIdArray,
    status: csvArray,
});
export { AppError };
//# sourceMappingURL=http.js.map