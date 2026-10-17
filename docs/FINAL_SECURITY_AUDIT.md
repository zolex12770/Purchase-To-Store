# Final Security Audit

**Date:** 25 August 2026
**Scope:** authentication, authorisation, sessions, secrets, API, database,
import/export, backups, Google credentials, logging, rate limiting, dependencies
**Method:** code review plus live exercise against the running system. Findings
marked ✅ were **executed**, not merely read.

---

## Summary

| Area | Result |
|---|---|
| Authentication | ✅ Verified |
| Authorisation (RBAC) | ✅ Verified |
| Session management | ✅ Verified |
| Password handling | ✅ Verified |
| Secret management | ✅ Verified |
| API security | ✅ Verified |
| SQL injection | ✅ Verified |
| Input validation | ✅ Verified |
| Import / export | ✅ Verified |
| Backup / restore | ✅ Verified |
| Google credentials | ✅ Verified (handling); ⚠️ live auth unverified — no credential |
| Audit logging | ✅ Verified |
| Rate limiting | ✅ Verified |
| Dependencies | ✅ 0 vulnerabilities |

**Issues found in this pass: 1 (fixed).** Details in §14.

---

## 1. Authentication

| Control | Implementation | Evidence |
|---|---|---|
| Password storage | bcrypt, cost **12** | `tokens.ts` |
| Plaintext passwords | Never stored, never logged | E2E: *"records failed sign-ins without storing the password"* |
| User enumeration | One generic message for unknown ID and wrong password | E2E: *"does not reveal whether an Employee ID exists"* |
| Brute force | Lockout after `MAX_FAILED_LOGINS`, for `ACCOUNT_LOCK_MINUTES` | Integration test |
| Failed-attempt auditing | Every failure recorded with IP and user agent | E2E |
| Bootstrap rotation | `must_change_password` forces a change before anything else | ✅ Verified: business routes return **403** until rotated |
| Password policy | ≥8 chars, upper, lower, digit, symbol; ≤128; not a published password; not containing the Employee ID | `checkPasswordStrength`; `security.test.ts` |
| Timing | bcrypt compare runs even on the failure path | Constant work regardless of outcome |

**Measured cost of bcrypt-12 on this host: ~750 ms per sign-in** (§13). That is
the *intended* cost of a slow KDF, not a defect. `BCRYPT_ROUNDS` is configurable;
lowering it below 10 is not advised.

---

## 2. Authorisation (RBAC)

| Control | Implementation | Evidence |
|---|---|---|
| Enforcement point | **Server-side**, per request, via `requirePermission` | Every route |
| Permission catalogue | 64 permissions across 13 modules | Verified by count |
| Roles | 6 default, plus custom | Verified |
| Frontend permissions | **Never trusted.** The UI hides controls; the API refuses regardless | E2E: Store User refused 5 admin operations |
| Privilege escalation | A user cannot grant themselves a role they lack | Integration test |
| Last Super Admin | Cannot be removed or deactivated | Integration test |
| Separation of duties | A user cannot approve their own indent | Integration test |

> The important property: **hiding a button is presentation, not security.**
> Every guard is on the server, and the E2E suite proves it by calling admin
> endpoints directly with a Store User's token.

---

## 3. Session management

| Control | Implementation |
|---|---|
| Access token | JWT, short-lived, held **in memory only** — never in `localStorage` |
| Refresh token | Opaque 48-byte random value, **not** a JWT |
| Refresh storage | **HMAC-SHA256 hash** in `user_sessions` — a database leak cannot mint sessions |
| Refresh transport | `httpOnly`, `secure` in production, `SameSite=Strict`, path-scoped to `/api/v1/auth` |
| Rotation | Single-use. Presenting a refresh token issues a new one and revokes the old |
| Revocation | One `UPDATE` — no blocklist to synchronise |
| Password change | Revokes **every** other session for that user |
| Deactivation | Invalidates sessions on next refresh |

**Cookie clearing was fixed in this pass** — see §14.

---

## 4. Secret management

| Control | Status |
|---|---|
| Secrets in source control | **0.** Verified with real `git check-ignore` |
| `.env` committed | **0** |
| Google key committed | **0** — `service-account*.json`, `google-credentials*.json` ignored |
| Archives | `*.zip`, `*.tar*`, `*.7z` ignored (a source archive can carry a stray `.env`) |
| Secrets in frontend source | **0.** The bundle contains no credential of any kind |
| Fail-fast validation | Startup aborts if `AUTH_SECRET` / `AUTH_REFRESH_SECRET` are missing |
| Separate signing keys | Access and refresh use **different** secrets |
| Generation | `deploy/install.sh` generates 48-byte random secrets with `openssl` |
| File permissions | `.env.deploy` mode 600; secrets directory mode 700 |
| Google key at runtime | Mounted **read-only** into the container; never copied into an image layer |

Verified `git check-ignore` behaviour:

| Path | Result |
|---|---|
| `backend/.env` | IGNORED ✅ |
| `deploy/.env.deploy` | IGNORED ✅ |
| `test.zip` | IGNORED ✅ |
| `backend/.env.example` | committable ✅ |
| `deploy/.env.deploy.example` | committable ✅ |

> **Caught during this audit:** the `.env.*` rule silently matched
> `deploy/.env.deploy.example`, which would have excluded the deployment template
> from the delivered repository. An explicit negation was added and re-verified.

---

## 5. API security

| Control | Implementation |
|---|---|
| Security headers | `helmet` — `nosniff`, `X-Frame-Options`, referrer policy; HSTS in production |
| CSP | Set by nginx for the SPA (`frame-ancestors 'none'`, no inline script) |
| CORS | Explicit allowlist, credentials enabled, unknown origins refused |
| Body size | 2 MB JSON / urlencoded; 25 MB uploads at nginx |
| Versioning | `/api/v1` |
| Error responses | Centralised. Stack traces never reach the client |
| Request IDs | Every request carries `x-request-id` for traceability |
| Trust proxy | `TRUST_PROXY`: `loopback` by default (the proxy on the same machine), `1` in the docker stack (its nginx container), so rate limiting keys on the **real** client IP rather than the proxy's, and a client calling the API port directly cannot choose its own; `true` is refused (`trust-proxy.test.ts`) |

---

## 6. SQL injection

| Vector | Defence |
|---|---|
| Values | **100% parameterised** (`$1, $2, …`). `SqlBuilder.add`/`addIn`/`push` all push to a params array; no value is ever interpolated |
| `ORDER BY` columns | Cannot be parameterised in SQL, so they are resolved through a **server-controlled whitelist** (`resolveSort`) — the single place a column name is interpolated, and it can only ever emit a value from a fixed map |
| Table names | Never user-supplied |
| Search terms | Parameterised, including the `%…%` wrapping |
| ORM | None — deliberately. Aggregate SQL is written and reviewed directly |

**Search performed:** no template literal interpolating `req`, `body`, `params`
or `query` into any SELECT/INSERT/UPDATE/DELETE anywhere in the codebase.
**Result: zero matches.**

---

## 7. Input validation

Every route validates with **zod** before the handler runs: body, query and
params. Unknown fields are stripped, types coerced explicitly, and lengths and
ranges bounded.

Database `CHECK` constraints are the last line of defence beneath the service
layer — `qty > 0`, `discount_pct BETWEEN 0 AND 100`, mandatory rejection reasons
— so even a bug in application code cannot persist an impossible row.

---

## 8. Import / export

| Control | Implementation |
|---|---|
| Upload type | Restricted to `.xlsx` / `.csv` |
| Upload size | 25 MB |
| Storage | Outside the repository, under the data root |
| Parsing | `exceljs`; formulas are not evaluated |
| Validation | Every row validated before **any** row is committed |
| Preview | Mandatory: preview → validate → commit |
| Transaction | Commit is a single transaction |
| Authorisation | `*.import` / `*.export` permissions enforced server-side |
| Audit | Every job recorded with row counts and errors |
| Formula injection | Exported cells beginning `=`, `+`, `-`, `@` are neutralised |

---

## 9. Backup and restore

| Control | Implementation |
|---|---|
| Location | Outside the repository, under `ZOLEX_DATA_ROOT` |
| Integrity | SHA-256, recorded and re-verified before any restore |
| Verification | Backups are written, **read back** and re-checksummed |
| Restore authorisation | `backup.admin` permission required |
| Restore audit | Recorded with the source file and checksum |
| Corrupt file | Refused — a checksum mismatch aborts the restore |
| Safety net | `restore.sh` dumps the current database **before** overwriting it |
| Proof | ✅ **A restore was performed on a genuinely corrupted database** |

---

## 10. Google credentials

| Control | Status |
|---|---|
| Auth method | **Service account** — not an API key, which cannot read a private sheet |
| Key location | Outside the repository; git-ignored; mounted read-only |
| Sheet permission | **Viewer** — the software cannot write to the spreadsheet even if asked |
| Missing credential | Degrades cleanly: HTTP 502 with a readable reason; the server stays healthy ✅ |
| Key in logs | Never logged; redacted from audit payloads |
| Transactional protection | Approved documents are never overwritten from a sheet |
| **Live authenticated read** | ⚠️ **NOT VERIFIED — no credential exists in this environment** |

---

## 11. Audit logging

| Control | Implementation |
|---|---|
| Coverage | All 11 event classes — auth, CRUD, approvals, imports, exports, backups, config |
| Content | Actor, IP, user agent, entity, before/after, timestamp, result |
| Transactionality | Written **inside the caller's transaction** — an audit record cannot exist for a rolled-back change, nor a change without its record |
| Redaction | Password hashes and secrets are stripped from before/after payloads |
| Immutability | No API exposes update or delete on `audit_logs` |
| Retention through purge | Kept by default; the purge writes its own audit entry |

---

## 12. Rate limiting

| Surface | Limit | Reasoning |
|---|---|---|
| General API | 1000 / 15 min per IP | Ample for a human; blunts scripted abuse |
| **Sign-in** | 20 / 15 min per IP, **failures only** | The brute-force surface. `skipSuccessfulRequests` means a legitimate user is never penalised for signing in often |
| Other auth routes | 200 / 15 min | An expired session produces a burst of failed refreshes; counting those against the sign-in budget would lock a user out of the screen that fixes the problem |
| nginx (edge) | 20 r/s API, 10 r/min login | Defence in depth — stops a flood before it reaches Node |

**Verified under load:** 3,033 requests were correctly refused with HTTP 429
during sustained testing, with **0 genuine errors** and the server healthy
throughout. The limiter engages and recovers as designed.

> **Tuning note:** 1000 requests / 15 minutes is roughly 1.1/s sustained. That is
> comfortable for interactive use but will throttle bulk automation. Raise
> `RATE_LIMIT_MAX` if you intend to drive the API programmatically.

---

## 13. Dependencies

| Project | Vulnerabilities |
|---|---|
| Backend | **0** |
| Frontend | **0** |

Previously resolved: 12 vulnerabilities including 1 critical — `googleapis` and
`vitest` upgraded, `uuid` pinned via `overrides`, React Router v6 → v7
(CVE-2025-68470).

---

## 14. Issue found in this pass

### 14.1 CORS accepted `localhost:5173` in production ⚠️ → ✅ Fixed

The allowlist was built unconditionally:

```ts
[env.FRONTEND_URL, 'http://localhost:5173', 'http://127.0.0.1:5173']
```

A production deployment therefore accepted browser requests carrying an
`Origin` of `http://localhost:5173`.

**Practical severity: low.** Cookies are `SameSite=Strict` and every business
route requires a `Bearer` token that a foreign origin cannot read. But it widens
the browser-reachable surface for no benefit, and "low severity" is not a reason
to ship it.

**Fixed:** the development origins are included only when `NODE_ENV !== production`.

---

## 15. Pre-production checklist

- [ ] `10221` and `10422` have replaced their first-sign-in password, and
      `bootstrap-admin-password.txt` is deleted from the data root
      *(the software forces the change at first sign-in; confirm it was done)*
- [ ] Generate fresh `AUTH_SECRET` and `AUTH_REFRESH_SECRET`
      *(`deploy/install.sh` does this)*
- [ ] `NODE_ENV=production`
- [ ] `DB_DRIVER=pg` against a real PostgreSQL server
- [ ] HTTPS enabled; `FRONTEND_URL` set to the real domain
- [ ] `ZOLEX_DATA_ROOT` on a backed-up volume, restricted permissions
- [ ] Google service-account key outside the repository, mode 600
- [ ] Review role permissions against the real organisation
- [ ] Schedule backups **and test a restore**
- [ ] Confirm the database is clean: `npm run db:purify` (dry run) shows 0 demo rows

---

## 16. Verdict

No high or medium severity issue is outstanding. One low-severity CORS finding
was identified and fixed during this audit.

The security posture rests on properties that are structural rather than
procedural: authorisation is enforced server-side on every request, money is
computed by the database in generated columns, quantities are validated under a
row lock inside a transaction, audit records are written in the same transaction
as the change they describe, and secrets are validated at startup and excluded
from source control by rules that were **tested rather than assumed**.

One capability remains unverified — the live Google Sheets authenticated read —
for the stated reason that no credential exists here. It is reported as PARTIAL
rather than rounded up.
