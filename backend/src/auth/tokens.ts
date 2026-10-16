/**
 * Token & password primitives (ADR-013, SRS §6, §25).
 */
import jwt, { type SignOptions } from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { env } from '../config/env.js';
import { AuthenticationError } from '../core/errors.js';

export interface AccessTokenPayload {
  sub: number;
  employeeId: string;
  name: string;
  roles: string[];
  permissions: string[];
  mustChangePassword: boolean;
}

export function signAccessToken(payload: AccessTokenPayload): string {
  const options: SignOptions = {
    expiresIn: env.ACCESS_TOKEN_TTL as SignOptions['expiresIn'],
    issuer: 'zolex-erp',
    audience: 'zolex-erp-client',
  };
  return jwt.sign(payload, env.AUTH_SECRET, options);
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  try {
    return jwt.verify(token, env.AUTH_SECRET, {
      issuer: 'zolex-erp',
      audience: 'zolex-erp-client',
    }) as unknown as AccessTokenPayload;
  } catch (err) {
    const expired = err instanceof Error && err.name === 'TokenExpiredError';
    throw AuthenticationError(expired ? 'Your session has expired. Please sign in again.' : 'Invalid session token.');
  }
}

/**
 * Refresh tokens are opaque random strings, not JWTs: they are stored hashed in
 * `user_sessions` so a database leak cannot mint sessions, and revoking one is a
 * single UPDATE rather than a blocklist.
 */
export function generateRefreshToken(): { token: string; hash: string } {
  const token = crypto.randomBytes(48).toString('base64url');
  return { token, hash: hashRefreshToken(token) };
}

export function hashRefreshToken(token: string): string {
  return crypto.createHmac('sha256', env.AUTH_REFRESH_SECRET).update(token).digest('hex');
}

export function refreshTokenExpiry(): Date {
  return new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
}

/* ── Passwords ──────────────────────────────────────────────────────────────── */

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, env.BCRYPT_ROUNDS);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  try {
    return await bcrypt.compare(plain, hash);
  } catch {
    return false;
  }
}

export interface PasswordCheck {
  ok: boolean;
  problems: string[];
}

/**
 * Passwords attackers already know, refused however strong they look. Each entry
 * is the SHA-256 hex digest of the lower-cased password, so this public
 * repository does not publish them again; a candidate is compared by digest.
 *   · the bootstrap / automated-test default, printed in the README, the docs and
 *     the start-up log (both production Super Admins were found using it);
 *   · the example in the Users screen's password fields, which administrators
 *     reused as the real password of three live accounts;
 *   · the credential hard-coded in the maintenance scripts (a live Super Admin's).
 */
const COMPROMISED_PASSWORD_SHA256 = new Set([
  'f3bcb069f76d9d319f203081e456f43dfb749291a9acaf8ae9e775c575446e54',
  'a742208667dae6de51f1fb845537d92ac08715cdfba929c86cd7fbde919131a7',
  '7676aaafb027c825bd9abab78b234070e702752f625b752e55e55b48e607e358',
]);

/** An Employee ID this short would refuse ordinary passwords rather than guessable ones. */
const MIN_EMPLOYEE_ID_CHECK_LENGTH = 3;

/**
 * Password policy, applied on every set/change (SRS §25). `employeeId` is the
 * account the password is for: the sign-in name is the first thing an attacker
 * tries inside a password.
 */
export function checkPasswordStrength(password: string, context: { employeeId?: string | null } = {}): PasswordCheck {
  const problems: string[] = [];
  if (password.length < 8) problems.push('be at least 8 characters long');
  if (password.length > 128) problems.push('be no longer than 128 characters');
  if (!/[a-z]/.test(password)) problems.push('include a lowercase letter');
  if (!/[A-Z]/.test(password)) problems.push('include an uppercase letter');
  if (!/[0-9]/.test(password)) problems.push('include a digit');
  if (!/[^A-Za-z0-9]/.test(password)) problems.push('include a special character');

  const normalised = password.trim().toLowerCase();
  if (COMPROMISED_PASSWORD_SHA256.has(crypto.createHash('sha256').update(normalised).digest('hex'))) {
    problems.push('not be one that has been published (it is known to attackers)');
  }
  const employeeId = context.employeeId?.trim().toLowerCase() ?? '';
  if (employeeId.length >= MIN_EMPLOYEE_ID_CHECK_LENGTH && normalised.includes(employeeId)) {
    problems.push('not contain the Employee ID');
  }
  return { ok: problems.length === 0, problems };
}

/** Constant-time comparison helper for non-hash secrets. */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}
