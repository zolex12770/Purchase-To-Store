/**
 * Express application factory (SRS §21, §25).
 *
 * Security middleware, the versioned API surface, and centralised error handling.
 * Exported as a factory so integration tests can mount the app without binding a port.
 */
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import crypto from 'node:crypto';
import { env } from './config/env.js';
import { logger } from './core/logger.js';
import { AppError, ServerError, NotFoundError, AuthorizationError, translateDatabaseError } from './core/errors.js';
import { requireAuth, blockIfPasswordChangeRequired } from './auth/middleware.js';
import authRoutes from './auth/routes.js';
import lookupRoutes from './modules/masters/lookup.routes.js';
import supplierRoutes from './modules/masters/supplier.routes.js';
import itemRoutes from './modules/masters/item.routes.js';
import indentRoutes from './modules/indent/routes.js';
import poRoutes from './modules/purchase-order/routes.js';
import grnRoutes from './modules/grn/routes.js';
import requisitionRoutes from './modules/requisition/routes.js';
import analyticsRoutes from './modules/analytics/routes.js';
import searchRoutes from './modules/search/routes.js';
import userRoutes from './modules/admin/user.routes.js';
import roleRoutes from './modules/admin/role.routes.js';
import auditRoutes from './modules/admin/audit.routes.js';
import settingsRoutes from './modules/admin/settings.routes.js';
import backupRoutes from './modules/admin/backup.routes.js';
import ioRoutes from './modules/io/routes.js';
import syncRoutes from './modules/google-sync/routes.js';
import googleDbRoutes from './modules/google-db/routes.js';
import { getDatabase } from './db/index.js';
export function createApp() {
    const app = express();
    // Behind a reverse proxy in production, trust exactly one hop so `req.ip` is the
    // real client (rate limiting and audit trails depend on it) without allowing
    // arbitrary X-Forwarded-For spoofing.
    app.set('trust proxy', env.isProd ? 1 : false);
    app.disable('x-powered-by');
    /* ── Request identity & timing ───────────────────────────────────────────── */
    app.use((req, res, next) => {
        const requestId = req.get('x-request-id') ?? crypto.randomUUID();
        res.locals.requestId = requestId;
        res.setHeader('x-request-id', requestId);
        const started = Date.now();
        res.on('finish', () => {
            const ms = Date.now() - started;
            if (req.path.startsWith('/api')) {
                const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'debug';
                logger[level](`${req.method} ${req.originalUrl} ${res.statusCode} ${ms}ms`, {
                    requestId,
                    userId: req.user?.id ?? null,
                });
            }
        });
        next();
    });
    /* ── Security headers (SRS §25) ──────────────────────────────────────────── */
    app.use(helmet({
        contentSecurityPolicy: false, // API only serves JSON; the SPA sets its own CSP
        crossOriginResourcePolicy: { policy: 'cross-origin' },
        hsts: env.isProd ? { maxAge: 31536000, includeSubDomains: true } : false,
    }));
    // FRONTEND_URL pins ONE way of reaching this server (e.g. the LAN IP), but the
    // same machine is also legitimately reached as localhost/127.0.0.1 on that same
    // port — from the server itself, or from a browser profile that resolves the
    // hostname differently. Rejecting those was the actual cause of intermittent
    // login failures: identical credentials, different origin string, one CORS
    // allow-list entry. Same physical port, so no broadening of what's reachable —
    // only of how this one machine may be addressed.
    const allowedOrigins = new Set([
        env.FRONTEND_URL,
        ...(() => {
            try {
                const port = new URL(env.FRONTEND_URL).port;
                return port ? [`http://localhost:${port}`, `http://127.0.0.1:${port}`] : [];
            }
            catch {
                return [];
            }
        })(),
        ...(env.isProd ? [] : ['http://localhost:5173', 'http://127.0.0.1:5173']),
    ].filter(Boolean));
    app.use(cors({
        origin(origin, cb) {
            // Same-origin/tools requests carry no Origin header.
            if (!origin || allowedOrigins.has(origin))
                return cb(null, true);
            // A real AppError (not a raw Error) so a rejected origin reaches the
            // browser as a clear 403 instead of falling into the generic 500
            // "unexpected error" path — that swallowed message was the actual
            // cause of unexplained login failures from an unlisted origin.
            cb(AuthorizationError(`This app is not permitted to load from ${origin}.`));
        },
        credentials: true,
        exposedHeaders: ['x-request-id', 'content-disposition'],
    }));
    app.use(express.json({ limit: '2mb' }));
    app.use(express.urlencoded({ extended: true, limit: '2mb' }));
    app.use(cookieParser());
    /* ── Rate limiting (SRS §21) ─────────────────────────────────────────────── */
    const windowMs = env.RATE_LIMIT_WINDOW_MINUTES * 60 * 1000;
    const generalLimiter = rateLimit({
        windowMs,
        max: env.RATE_LIMIT_MAX,
        standardHeaders: true,
        legacyHeaders: false,
        message: { success: false, error: { code: 'RATE_LIMITED', message: 'Too many requests. Please slow down.' } },
    });
    // Sign-in is limited tightly — it is the brute-force surface. Only FAILED
    // attempts count, so a legitimate user is never penalised for signing in often.
    const loginLimiter = rateLimit({
        windowMs,
        max: env.AUTH_RATE_LIMIT_MAX,
        standardHeaders: true,
        legacyHeaders: false,
        skipSuccessfulRequests: true,
        message: { success: false, error: { code: 'RATE_LIMITED', message: 'Too many sign-in attempts. Please try again later.' } },
    });
    // The remaining auth routes (refresh, logout, me, change-password) are NOT a
    // credential-guessing surface, and an expired session naturally produces a burst
    // of failed refreshes. Counting those against the sign-in budget would lock a
    // user out of the very screen that fixes the problem.
    const authLimiter = rateLimit({
        windowMs,
        max: Math.max(env.AUTH_RATE_LIMIT_MAX * 10, 200),
        standardHeaders: true,
        legacyHeaders: false,
        message: { success: false, error: { code: 'RATE_LIMITED', message: 'Too many requests. Please slow down.' } },
    });
    /* ── Health (SRS §21, §57) ───────────────────────────────────────────────── */
    app.get('/api/v1/health', async (_req, res) => {
        const started = Date.now();
        try {
            const db = await getDatabase();
            await db.query('SELECT 1');
            res.json({
                success: true,
                data: {
                    status: 'ok',
                    service: 'zolex-erp-backend',
                    version: '1.0.0',
                    environment: env.NODE_ENV,
                    database: { driver: db.driver, reachable: true, latencyMs: Date.now() - started },
                    time: new Date().toISOString(),
                },
            });
        }
        catch (err) {
            res.status(503).json({
                success: false,
                error: {
                    code: 'SERVER_ERROR',
                    message: 'Database is not reachable.',
                    requestId: res.locals.requestId,
                },
                data: { status: 'degraded', database: { reachable: false } },
            });
            logger.error('Health check failed', { error: err instanceof Error ? err.message : String(err) });
        }
    });
    /* ── API surface (SRS §21: versioned, domain-organised) ──────────────────── */
    const api = express.Router();
    api.use('/auth/login', loginLimiter);
    api.use('/auth', authLimiter, authRoutes);
    // Everything below requires a session, and refuses users who owe a password rotation.
    const guarded = express.Router();
    guarded.use(generalLimiter, requireAuth, blockIfPasswordChangeRequired);
    guarded.use('/lookups', lookupRoutes);
    guarded.use('/suppliers', supplierRoutes);
    guarded.use('/items', itemRoutes);
    guarded.use('/indents', indentRoutes);
    guarded.use('/purchase-orders', poRoutes);
    guarded.use('/grn', grnRoutes);
    guarded.use('/requisitions', requisitionRoutes);
    guarded.use('/analytics', analyticsRoutes);
    guarded.use('/search', searchRoutes);
    guarded.use('/users', userRoutes);
    guarded.use('/roles', roleRoutes);
    guarded.use('/audit', auditRoutes);
    guarded.use('/settings', settingsRoutes);
    guarded.use('/backup', backupRoutes);
    guarded.use('/io', ioRoutes);
    guarded.use('/google-sync', syncRoutes);
    guarded.use('/google-db', googleDbRoutes);
    api.use(guarded);
    app.use('/api/v1', api);
    /* ── 404 for unmatched API routes ────────────────────────────────────────── */
    app.use('/api', (req, _res, next) => {
        next(NotFoundError(`Endpoint ${req.method} ${req.originalUrl}`));
    });
    /* ── Centralised error handler (SRS §21, §37) ────────────────────────────── */
    // Stack traces are logged, never serialised to the client.
    app.use((err, req, res, _next) => {
        const requestId = res.locals.requestId ?? null;
        let appErr;
        if (err instanceof AppError) {
            appErr = err;
        }
        else {
            const translated = translateDatabaseError(err);
            appErr = translated ?? ServerError();
        }
        if (!appErr.expected || appErr.status >= 500) {
            logger.error(`Unhandled error on ${req.method} ${req.originalUrl}`, {
                requestId,
                userId: req.user?.id ?? null,
                error: err instanceof Error ? err.message : String(err),
                stack: err instanceof Error ? err.stack?.split('\n').slice(0, 6).join(' | ') : undefined,
            });
        }
        if (res.headersSent)
            return;
        res.status(appErr.status).json({
            success: false,
            error: {
                code: appErr.code,
                message: appErr.message,
                ...(appErr.issues ? { issues: appErr.issues } : {}),
                ...(appErr.details ? { details: appErr.details } : {}),
                requestId,
            },
        });
    });
    return app;
}
//# sourceMappingURL=app.js.map