# 08 — Security

Covers SRS §6, §18, §24, §25, §27. Each control below is implemented and verified;
the test that proves it is named.

---

## 1. The governing principle

> **The frontend hides what a user cannot do. The server decides what a user cannot do.**

Every guarded route re-checks its permission on the server, so a hand-crafted request
from a signed-in Viewer is refused exactly like one from a stranger. Hiding a button
is ergonomics, never a security boundary.

Proven by `workflow.test.ts › RBAC enforcement`, which drives a real Store User token
at admin endpoints and asserts 403 on each.

---

## 2. Authentication (ADR-013)

| Control | Implementation |
|---|---|
| Password storage | **bcryptjs**, cost 12. Plaintext is never stored or logged. Pure JS — no native build step. |
| Password policy | ≥ 8 chars with lower, upper, digit and symbol; never a published password (compared by SHA-256 digest, so the list does not republish them) and never one containing the account's Employee ID; enforced on every set and change |
| Access token | JWT, 8-hour default, issuer/audience bound, held **in memory** in the browser so an XSS payload cannot read it out of storage |
| Refresh token | Opaque 48-byte random value, stored **HMAC-hashed** in `user_sessions` — a database leak cannot mint sessions |
| Refresh cookie | `httpOnly`, `sameSite=strict`, `secure` in production, scoped to `path=/api/v1/auth` |
| Rotation | Every refresh revokes the presented token and issues a new one; replay of a used token is refused |
| Revocation | Logout, password change and user deactivation revoke sessions **server-side**, not just client-side |
| Failed-login protection | 5 consecutive failures lock the account for 15 minutes; the counter resets on success |
| Enumeration resistance | "No such user" and "wrong password" return the *same* message and status |
| Bootstrap credentials | No default password: a new database gives `10221` / `10422` `BOOTSTRAP_ADMIN_PASSWORD` or a random password written once to `bootstrap-admin-password.txt` in the data root (never the log), with `must_change_password = true` |
| Forced password change | While `must_change_password` is set — a bootstrap account, a new account or an administrator's reset, both of which default to it — the API answers only `/auth/me`, change-password, refresh and logout; everything else is 403 `PASSWORD_CHANGE_REQUIRED`, judged on the account's live flag, and the web client shows only the change-password screen |

**Rate limiting is split by purpose.** `/auth/login` gets a tight budget counting
**failed attempts only**; the other auth routes get a far larger one. Counting failed
refreshes against the sign-in budget would lock a user out of the very screen that
fixes an expired session — a defect found and corrected during UI verification.

---

## 3. Authorisation (SRS §18)

**64 permissions** across 13 modules, in the form `module.action`:

```
dashboard · item · supplier · lookup · indent · po · grn
user · role · audit · sync · backup · system

view · create · edit · delete · approve · reject
export · import · print · analyze · admin
```

Six default roles: Super Admin, Purchase Head, Purchase User, Store User,
Management, Viewer. Administrators may create more with any permission combination.

**Structural safeguards**

- `SUPER_ADMIN` implicitly holds every permission, including ones added later, and
  **cannot be edited or deleted** — there is no way to create a system nobody can
  administer.
- Only a Super Admin can grant Super Admin.
- The system refuses to remove or deactivate the **last active Super Admin**.
- Nobody can deactivate their own account or drop their own Super Admin role.
- **Separation of duties:** a user cannot approve an indent they raised.
- Permissions are re-read from the database on `/auth/me` and on refresh, so a
  revoked grant takes effect immediately rather than at token expiry.

---

## 4. Input handling (SRS §25)

| Threat | Control |
|---|---|
| SQL injection | Every query is parameterised (`$1, $2 …`). No user value is ever concatenated into SQL. |
| Injection via `ORDER BY` | Sort columns cannot be parameterised, so they are resolved against a **server-controlled allow-list** — the only place an identifier is interpolated. |
| Injection via analytics dimension | Same pattern: an allow-list map; anything else is a 422. |
| Malformed input | `zod` schemas on every body and query; failures return field-level `issues[]`. |
| Oversized payloads | 2 MB JSON limit; 15 MB upload limit; import capped at 20,000 rows. |
| CSV formula injection | Exported cells beginning `= + - @` or a control character are prefixed with `'` so a spreadsheet cannot execute them. |
| Path traversal | Backup filenames are reduced to `path.basename` before touching the filesystem. |
| XSS | React escapes by default; no `dangerouslySetInnerHTML` anywhere in the codebase. |
| CSRF | Bearer token in a header (not ambient), plus `sameSite=strict` on the refresh cookie. |

Verified by `workflow.test.ts › input hardening`, which fires
`'; DROP TABLE items; --` at the search endpoint and then asserts the table survived.

---

## 5. Transport and headers

`helmet` sets the standard protective headers; HSTS is enabled in production. CORS
is an **allow-list** of known origins with credentials enabled — not a wildcard.
`x-powered-by` is disabled. `trust proxy` is `loopback`: only a reverse proxy on the
same machine (the vite server on 8080, whose `/api` proxy sets `xfwd`, or a local
nginx) may name the client in `X-Forwarded-For`, so `req.ip` is the real client for
rate limiting and audit, while a LAN client calling the API port directly is
identified by its own address whatever header it sends. (It was one hop of any
origin, which let such a client pick a fresh rate-limit bucket per request.)

---

## 6. Secrets (SRS §27)

- Configuration is validated once at boot; the process **exits** rather than starting
  half-configured.
- `AUTH_SECRET` and `AUTH_REFRESH_SECRET` must be ≥ 32 characters **in production**;
  the server refuses to start otherwise. Development generates a stable per-machine
  secret so tokens survive a restart.
- `.env` is git-ignored; only `.env.example` is committed.
- Google service-account keys are referenced **by path**, stored outside the
  repository, never inlined.
- The database, backups, uploads and logs all live outside the project folder.
- The frontend bundle contains **no credentials**. The development sign-in hint names
  the seeded account but carries no secret, and is compiled out of production builds.

---

## 7. Audit trail (SRS §24)

Every critical mutation records actor (id, employee id, name), action, entity,
entity id and label, **before and after values**, source (`API` / `GOOGLE_SYNC` /
`IMPORT` / `SYSTEM`), result, message, IP, user agent and request id.

Covered: login, failed login, logout, password change and reset, master CRUD, indent
submit/approve/reject/cancel, PO create/issue/cancel/short-close, GRN
create/post/cancel, import, export, print, sync, sync toggle, backup, restore, role
and permission changes, and setting changes.

Two properties that make the trail trustworthy:

1. **Business audits are written inside the caller's transaction.** If the document
   rolls back, so does its audit record — the trail can never claim something
   happened that did not.
2. **Sensitive values are scrubbed before persistence.** Password fields, hashes and
   tokens are replaced with `[redacted]` in both the audit trail and the log files.
   `workflow.test.ts` asserts a failed sign-in never stores the attempted password.

---

## 8. Business-integrity controls

These are security controls in the sense that matters to an ERP — they stop value
being created or destroyed incorrectly.

- Ordering and receipt quantities are validated **inside a transaction** holding
  `SELECT … FOR UPDATE` on the source row, so two concurrent requests cannot both
  consume the same quantity. Proven by two concurrency tests that fire simultaneous
  requests and assert exactly one succeeds.
- `final_rate` and `amount` are database-generated, so a client cannot submit a
  forged amount.
- Document numbers come from a locked counter plus a `UNIQUE` constraint — a race
  cannot mint a duplicate.
- Approved indents, issued POs and posted GRNs are immutable; correction is by
  cancellation with a mandatory reason, leaving the history intact.
- Restore verifies the backup's SHA-256 checksum first and **refuses** a file that
  has changed since it was created.

---

## 9. Known limitations

Stated plainly rather than omitted:

| Limitation | Status |
|---|---|
| No MFA | Not in SRS scope. The auth layer would accommodate it without redesign. |
| No password history | Only "different from current" is enforced. |
| Rate limiting is in-process | Correct for one node; a multi-node deployment needs a shared store (Redis). See [09_DEPLOYMENT.md](09_DEPLOYMENT.md). |
| Audit log is append-only by convention | No cryptographic chaining; `audit.view` is read-only and no route deletes audit rows, but a database superuser could. |
| Embedded engine is single-writer | Production should use `DB_DRIVER=pg`. See [04_KNOWN_ISSUES.md](04_KNOWN_ISSUES.md). |

---

## 10. Pre-production checklist

- [ ] Confirm `10221` and `10422` replaced their first-sign-in password (the software forces it) and `bootstrap-admin-password.txt` is gone from the data root — or deactivate them in favour of named administrators
- [ ] Set `AUTH_SECRET` and `AUTH_REFRESH_SECRET` to fresh 48-byte random values
- [ ] Set `NODE_ENV=production` (enables `secure` cookies and HSTS, disables `db:reset`)
- [ ] Point `DB_DRIVER=pg` at a real PostgreSQL server with least-privilege credentials
- [ ] Serve over HTTPS and set `FRONTEND_URL` to the real origin
- [ ] Set `ZOLEX_DATA_ROOT` to a backed-up volume with restricted OS permissions
- [ ] Store the Google service-account key outside the repository, readable only by the service user
- [ ] Review every role's permissions against the actual organisation
- [ ] Schedule backups and **test a restore** — an untested backup is not a backup
