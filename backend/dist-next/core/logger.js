/**
 * Structured logger (SRS §57 observability).
 *
 * Writes human-readable lines to the console and newline-delimited JSON to
 * $ZOLEX_DATA_ROOT/logs/zolex-YYYY-MM-DD.log (outside the repository).
 */
import fs from 'node:fs';
import path from 'node:path';
import { env, paths } from '../config/env.js';
const ORDER = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };
const threshold = ORDER[env.LOG_LEVEL];
const COLOR = {
    debug: '\x1b[90m',
    info: '\x1b[36m',
    warn: '\x1b[33m',
    error: '\x1b[31m',
};
const RESET = '\x1b[0m';
let stream = null;
let streamDay = '';
function fileStream() {
    if (env.isTest)
        return null;
    const day = new Date().toISOString().slice(0, 10);
    if (stream && streamDay === day)
        return stream;
    try {
        fs.mkdirSync(paths.logs, { recursive: true });
        stream?.end();
        stream = fs.createWriteStream(path.join(paths.logs, `zolex-${day}.log`), { flags: 'a' });
        streamDay = day;
        return stream;
    }
    catch {
        return null;
    }
}
/** Keys whose values must never reach a log file. */
const REDACT = new Set([
    'password', 'newpassword', 'currentpassword', 'confirmpassword',
    'passwordhash', 'password_hash', 'token', 'accesstoken', 'refreshtoken',
    'refresh_token', 'authorization', 'cookie', 'secret', 'apikey', 'api_key',
]);
function redact(value, depth = 0) {
    if (depth > 6 || value === null || typeof value !== 'object')
        return value;
    if (Array.isArray(value))
        return value.slice(0, 50).map((v) => redact(v, depth + 1));
    const out = {};
    for (const [k, v] of Object.entries(value)) {
        out[k] = REDACT.has(k.toLowerCase()) ? '[redacted]' : redact(v, depth + 1);
    }
    return out;
}
function write(level, message, meta) {
    if (ORDER[level] < threshold)
        return;
    const time = new Date();
    const safeMeta = meta ? redact(meta) : undefined;
    const prefix = `${COLOR[level]}${level.toUpperCase().padEnd(5)}${RESET}`;
    const tail = safeMeta && Object.keys(safeMeta).length > 0 ? ` ${JSON.stringify(safeMeta)}` : '';
    // eslint-disable-next-line no-console
    console.log(`${prefix} ${time.toISOString().slice(11, 23)} ${message}${tail}`);
    const fs2 = fileStream();
    if (fs2) {
        fs2.write(`${JSON.stringify({ ts: time.toISOString(), level, message, ...safeMeta })}\n`);
    }
}
export const logger = {
    debug: (m, meta) => write('debug', m, meta),
    info: (m, meta) => write('info', m, meta),
    warn: (m, meta) => write('warn', m, meta),
    error: (m, meta) => write('error', m, meta),
};
//# sourceMappingURL=logger.js.map