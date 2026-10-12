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

/** Password policy, applied on every set/change (SRS §25). */
export function checkPasswordStrength(password: string): PasswordCheck {
  const problems: string[] = [];
  if (password.length < 8) problems.push('be at least 8 characters long');
  if (password.length > 128) problems.push('be no longer than 128 characters');
  if (!/[a-z]/.test(password)) problems.push('include a lowercase letter');
  if (!/[A-Z]/.test(password)) problems.push('include an uppercase letter');
  if (!/[0-9]/.test(password)) problems.push('include a digit');
  if (!/[^A-Za-z0-9]/.test(password)) problems.push('include a special character');
  return { ok: problems.length === 0, problems };
}

/** Constant-time comparison helper for non-hash secrets. */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}
