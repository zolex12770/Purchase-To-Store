/**
 * Break-glass: give an account a temporary password from the server's command line, for
 * when no Super Admin can sign in to reset it through Admin > Users.
 *
 *   pm2 stop zolex-purchase-backend
 *   npm run admin:recover -- 10422          (or: node dist/db/cli-recover-admin.js 10422)
 *   pm2 start zolex-purchase-backend
 *
 * The password is typed at a hidden prompt (twice), or piped on stdin by a program that
 * holds it, and is never printed or logged. It must pass the same rules as an
 * administrator's reset. The account must change it at its next sign-in (the API refuses
 * everything else until then); its lockout is cleared, its sessions end, and the action is
 * written to the audit log with the Windows user who ran it.
 *
 * The backend must be stopped: the embedded database admits one process at a time.
 */
import os from 'node:os';
import readline from 'node:readline';
import { env, ensureStorageDirs } from '../config/env.js';
import { closeDatabase, databaseLabel } from './driver.js';
import { queryOne, withTransaction } from './index.js';
import { auditIn } from '../core/audit.js';
import { checkPasswordStrength, hashPassword } from '../auth/tokens.js';
import { invalidateAuthState } from '../auth/middleware.js';

export interface RecoverResult { userId: number; employeeId: string; employeeName: string }

/** The recovery itself (exported for tests): validates, resets, revokes sessions, audits. */
export async function recoverAdminAccount(employeeId: string, password: string, actorLabel: string): Promise<RecoverResult> {
  const user = await queryOne<{ id: number; employee_id: string; employee_name: string; is_active: boolean }>(
    'SELECT id, employee_id, employee_name, is_active FROM users WHERE employee_id = $1 AND deleted_at IS NULL',
    [employeeId],
  );
  if (!user) throw new Error(`No account with Employee ID ${employeeId}.`);
  if (!user.is_active) throw new Error(`Account ${employeeId} is deactivated; reactivate it first.`);
  const strength = checkPasswordStrength(password, { employeeId: user.employee_id });
  if (!strength.ok) throw new Error(`Choose a stronger temporary password: it must ${strength.problems.join(', ')}.`);
  const hash = await hashPassword(password);
  await withTransaction(async (tx) => {
    await tx.query(
      `UPDATE users
          SET password_hash = $2, must_change_password = TRUE, failed_login_count = 0,
              locked_until = NULL, password_changed_at = now(), updated_at = now()
        WHERE id = $1`,
      [user.id, hash],
    );
    await tx.query('UPDATE user_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [user.id]);
    await auditIn(tx, {
      actor: { userId: null, employeeId: null, name: actorLabel },
      action: 'PASSWORD_RESET', entity: 'user', entityId: user.id, entityLabel: user.employee_id,
      message: 'Temporary password set from the server command line (break-glass); must be changed at the next sign-in; all sessions revoked',
    });
  });
  // No effect when the backend is stopped (the normal case); in-process it drops the cached auth state.
  invalidateAuthState(Number(user.id));
  return { userId: Number(user.id), employeeId: user.employee_id, employeeName: user.employee_name };
}

async function backendIsRunning(): Promise<boolean> {
  try {
    const r = await fetch(`http://localhost:${env.PORT}/api/v1/health`, { signal: AbortSignal.timeout(3000) });
    return r.ok;
  } catch {
    return false;
  }
}

function hiddenPrompt(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const out = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WriteStream };
    out._writeToOutput = (s: string) => { if (s.startsWith(question)) out.output.write(s); };
    rl.question(question, (answer) => { rl.close(); process.stdout.write('\n'); resolve(answer); });
  });
}

async function readPassword(): Promise<string> {
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const c of process.stdin) chunks.push(c as Buffer);
    return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
  }
  const first = await hiddenPrompt('New temporary password: ');
  const second = await hiddenPrompt('Type it again: ');
  if (first !== second) throw new Error('The two entries differ. Nothing was changed.');
  return first;
}

async function main(): Promise<void> {
  const employeeId = process.argv.slice(2).find((a) => !a.startsWith('--'));
  if (!employeeId) {
    console.error('Usage: npm run admin:recover -- <EmployeeID>   (stop the backend first)');
    process.exit(1);
  }
  if (await backendIsRunning()) {
    console.error(`The ERP backend is running on port ${env.PORT}. Stop it first (pm2 stop zolex-purchase-backend), then run this again.`);
    process.exit(1);
  }
  ensureStorageDirs();
  console.log(`Database: ${databaseLabel()}`);
  const password = await readPassword();
  const actor = `Break-glass CLI (${os.userInfo().username}@${os.hostname()})`;
  const r = await recoverAdminAccount(employeeId, password, actor);
  console.log(`Temporary password set for ${r.employeeName} (${r.employeeId}). They must change it at the next sign-in.`);
  console.log('Start the backend again: pm2 start zolex-purchase-backend');
}

const isMain = process.argv[1] && /cli-recover-admin\.(ts|js)$/.test(process.argv[1]);
if (isMain) {
  main()
    .catch((err) => { console.error(err instanceof Error ? err.message : String(err)); process.exitCode = 1; })
    .finally(() => closeDatabase());
}
