/**
 * Where the maintenance scripts in this folder send their API calls, and as whom.
 *
 * They used to hard-code a Super Admin's live password and the production
 * backend (127.0.0.1:4001). That published the credential in a public
 * repository, and let any run — by a person or an agent — act on production as
 * that administrator (AUTH-03). Now everything comes from the environment:
 *
 *   ZOLEX_SCRIPT_API_URL       the backend to call, e.g. http://127.0.0.1:4012 for a
 *                              staging copy (http only; default http://127.0.0.1:4001)
 *   ZOLEX_SCRIPT_EMPLOYEE_ID   the account to sign in as — an account made for
 *                              automation, not a Super Admin
 *   ZOLEX_SCRIPT_PASSWORD      its password; never written into a file in this repository
 *   ZOLEX_ALLOW_PRODUCTION=yes required before anything is sent to a production
 *                              port: 4001 (backend) or 8080 (the web proxy in front of it)
 *
 * The check runs when a script starts, before it reads or sends anything.
 */

const PRODUCTION_API = 'http://127.0.0.1:4001';
const PRODUCTION_PORTS = new Set([4001, 8080]);

export interface ScriptApiTarget {
  /** e.g. http://127.0.0.1:4012/api/v1 */
  baseUrl: string;
  hostname: string;
  port: number;
}

function refuse(message: string): never {
  // eslint-disable-next-line no-console
  console.error(`\n[zolex script] ${message}\n`);
  process.exit(1);
}

export function scriptApiTarget(): ScriptApiTarget {
  const raw = process.env.ZOLEX_SCRIPT_API_URL?.trim() || PRODUCTION_API;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    refuse(`ZOLEX_SCRIPT_API_URL is not a valid URL: ${raw}`);
  }
  if (url.protocol !== 'http:') refuse(`ZOLEX_SCRIPT_API_URL must be an http:// address: ${raw}`);
  const port = Number(url.port || 80);
  if (PRODUCTION_PORTS.has(port) && process.env.ZOLEX_ALLOW_PRODUCTION !== 'yes') {
    refuse(
      `${url.origin} is the PRODUCTION ERP (port ${port}). Point ZOLEX_SCRIPT_API_URL at a staging copy, ` +
      'or set ZOLEX_ALLOW_PRODUCTION=yes if you really mean to act on production.',
    );
  }
  return { baseUrl: `${url.origin}/api/v1`, hostname: url.hostname, port };
}

export function scriptCredentials(): { employeeId: string; password: string } {
  const employeeId = process.env.ZOLEX_SCRIPT_EMPLOYEE_ID?.trim();
  const password = process.env.ZOLEX_SCRIPT_PASSWORD;
  if (!employeeId || !password) {
    refuse('Set ZOLEX_SCRIPT_EMPLOYEE_ID and ZOLEX_SCRIPT_PASSWORD to the account this script signs in as (not a Super Admin).');
  }
  return { employeeId, password };
}
