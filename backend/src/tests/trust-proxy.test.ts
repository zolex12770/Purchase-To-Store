/**
 * Integration tests — which proxy may name the client's address (TRUST_PROXY,
 * audit AUTH-07, 2026-10-16).
 *
 * `req.ip` keys the sign-in rate limit and is what audit and session rows record.
 *   1. Unset, only a proxy on this machine is trusted. The docker stack's nginx
 *      connects from the compose network, so under the default every user would
 *      share its address and one sign-in budget; the stack sets 1 instead.
 *   2. The value reaches Express: a hop count, addresses and subnets, or false.
 *   3. A value that would let any client name its own address, or that is not an
 *      address, stops the server at boot with a message naming TRUST_PROXY.
 *
 * No database: each case loads the configuration and the app afresh under its own
 * TRUST_PROXY, which a file sharing the embedded database could not do safely (a
 * fresh module graph would open a second instance of it).
 */
import { describe, it, expect, vi, afterEach, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Express } from 'express';

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';

const COMPOSE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'deploy', 'docker-compose.yml');
/** The nginx container as the API sees it on the compose bridge network. */
const NGINX = '172.18.0.4';
/** A PC on the office LAN. */
const CLIENT = '172.16.18.40';
/** An address a client claims for itself. */
const FORGED = '203.0.113.9';

/** A fresh app whose configuration was loaded with TRUST_PROXY = `value`. */
async function appWith(value: string): Promise<Express> {
  vi.resetModules();
  process.env.TRUST_PROXY = value;
  const { createApp } = await import('../app.js');
  return createApp();
}

/** req.ip exactly as Express resolves it for a connection from `remoteAddress`. */
function ipOf(app: Express, remoteAddress: string, forwardedFor?: string): string {
  const req = Object.create(app.request) as { app: Express; headers: Record<string, string>; connection: unknown; socket: unknown; ip: string };
  req.app = app;
  req.headers = forwardedFor === undefined ? {} : { 'x-forwarded-for': forwardedFor };
  req.connection = { remoteAddress };
  req.socket = req.connection;
  return req.ip;
}

afterEach(() => { vi.restoreAllMocks(); });
afterAll(() => { delete process.env.TRUST_PROXY; });

describe('TRUST_PROXY', () => {
  it('unset, trusts only this machine — a proxy in another container would be every user', async () => {
    const app = await appWith('');
    expect(app.get('trust proxy')).toBe('loopback');
    expect(ipOf(app, '127.0.0.1', CLIENT)).toBe(CLIENT);
    expect(ipOf(app, NGINX, CLIENT)).toBe(NGINX);
  });

  it('as a hop count takes the address the proxy appended, and the docker stack sets 1', async () => {
    const compose = fs.readFileSync(COMPOSE, 'utf8');
    const apiService = compose.slice(compose.indexOf('\n  api:'), compose.indexOf('\n  web:'));
    expect(apiService).toMatch(/^\s+TRUST_PROXY: "1"\s*$/m);
    // One hop is safe only while the API port is not published: no client reaches it but nginx.
    expect(apiService).toMatch(/^ {4}expose:/m);
    expect(apiService).not.toMatch(/^ {4}ports:/m);

    const app = await appWith('1');
    expect(app.get('trust proxy')).toBe(1);
    expect(ipOf(app, NGINX, CLIENT)).toBe(CLIENT);
    // nginx appends the real address, so an entry the client wrote in front of it is ignored.
    expect(ipOf(app, NGINX, `${FORGED}, ${CLIENT}`)).toBe(CLIENT);
  });

  it('as addresses and subnets, trusts those and nothing else', async () => {
    const app = await appWith(' 172.18.0.0/16 , Loopback ');
    expect(app.get('trust proxy')).toBe('172.18.0.0/16,loopback');
    expect(ipOf(app, NGINX, CLIENT)).toBe(CLIENT);
    expect(ipOf(app, '::1', CLIENT)).toBe(CLIENT);
    // A LAN client calling the API port directly cannot choose its address.
    expect(ipOf(app, CLIENT, FORGED)).toBe(CLIENT);
  });

  it('as false, trusts no proxy at all', async () => {
    const app = await appWith('false');
    expect(app.get('trust proxy')).toBe(false);
    expect(ipOf(app, '127.0.0.1', CLIENT)).toBe('127.0.0.1');
  });

  it.each([
    ['true', 'true lets any client name its own address'],
    ['nginx', '"nginx" is not an address'],
    ['172.18.0.0/40', '"172.18.0.0/40" is not an address'],
    ['loopback,', '"" is not an address'],
  ])('refuses %s at boot', async (value, message) => {
    vi.resetModules();
    process.env.TRUST_PROXY = value;
    const exit = vi.spyOn(process, 'exit').mockImplementation((code) => { throw new Error(`exit ${String(code)}`); });
    const printed = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(import('../config/env.js')).rejects.toThrow('exit 1');
    expect(exit).toHaveBeenCalledWith(1);
    expect(String(printed.mock.calls[0]?.[0])).toContain(`TRUST_PROXY: ${message}`);
  });
});
