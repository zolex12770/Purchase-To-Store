# Administrator access recovery

**For:** the ERP administrator (the person with Windows access to the ERP server).

There is no default password. The one that shipped with early builds was published, and it was replaced on every account on 2026-10-16. Do not try it: five wrong attempts lock an account for 15 minutes.

## How sign-in works now

- **First sign-in after a reset.** A person given a temporary password (by an administrator, or by the break-glass command below) can sign in, but sees only **Set a new password** until they choose their own. The API refuses everything else until then.
- **Password rules.** At least 8 characters, with upper and lower case, a digit and a symbol. The password must not contain the Employee ID, and must not be a published or example password.
- **Lockout.** Five wrong passwords lock the account for 15 minutes. An administrator can lift the lock early in **Admin › Users › (person) › Unlock**.
- **Audit.** Every reset, unlock and change is written to the audit log.

## Someone forgot their password

1. Another Super Admin opens **Admin › Users**, finds the person and chooses **Reset password**. Leave "must change at next sign-in" ticked.
2. Give the temporary password to that person only, in person or by phone. Never send it by e-mail or chat, or write it on paper.

## Temporary passwords kept on the server

When temporary passwords have to be handed over later, they are kept **encrypted** on the ERP server, outside this repository. They are protected with Windows DPAPI, so only the Windows account that owns that folder, on that server, can read them; the folder's permissions also allow only that account.

The folder holds `ADMIN-ACCESS-RECOVERY.txt`, which gives the exact location and steps, and a helper that copies one password to the clipboard without showing it. Delete a person's entry once they have chosen their own password.

## Break-glass: no Super Admin can sign in

Use this only when nobody can reset the account through the screen. Do it on the server, in a terminal opened in the project's `backend` folder:

```powershell
pm2 stop zolex-purchase-backend        # the embedded database admits one process at a time
npm run admin:recover -- 10422         # type the temporary password twice at the hidden prompt
pm2 start zolex-purchase-backend
```

The command:

- refuses to run while the backend is running;
- applies the same password rules as a screen reset;
- makes the account change the password at its next sign-in;
- clears the lockout and ends the account's sessions;
- writes an audit entry naming the Windows user who ran it.

It never prints or logs the password. A program that holds the password may pipe it on standard input instead of typing it.

Stop and start **only** `zolex-purchase-backend`. The other applications on this server are separate systems.
