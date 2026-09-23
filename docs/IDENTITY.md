# Identity and permissions

This is the first slice of the 0.2 identity foundation. It replaces the 0.1 demonstration personas with real accounts. It is still a local development release. Keep to synthetic data until deployment, backup, and review work is done.

## Accounts and roles

| Role | Documentation | Clients | Users and security events |
|---|---|---|---|
| `admin` | Read and write | Always all clients | Manage |
| `technician` | Read and write | All clients, or only granted clients | — |
| `client` | Read only | Granted clients only (at least one) | — |

- Only an unrestricted account (admin, or technician with all-client access) can create client workspaces.
- A restricted technician can edit only granted clients. Every other client returns 404, the same as a missing record.
- The server rebuilds each request's role and grants from the database. Promoting, demoting, re-scoping, or disabling someone takes effect on their next request without signing them out.
- Safeguards: administrators cannot demote or disable themselves, the last active administrator cannot be removed, and administrators change their own password on the Account page, not through a reset.

## First-run setup

When the database has no users, `server/index.mjs` generates a random setup code and prints it only to the server console. `POST /api/setup` needs that code, runs in one transaction, and stops working once any user exists. Wrong codes count toward the per-address rate limit.

## Passwords

- scrypt (N=32768, r=8, p=1) with a per-password 16-byte salt. The parameters are stored in each hash so they can be raised later.
- Passwords must be 12–256 characters, reasonably varied, and must not contain the email name.
- Unknown emails still run a full scrypt check, so response time doesn't reveal whether an account exists. Unknown, disabled, and wrong-password sign-ins all return the same error.
- Administrator-issued passwords are temporary. The user must replace one before using the workspace.
- Changing a password signs out the account's other sessions. An administrator reset signs out every session.

## MFA

- Uses authenticator-app codes (TOTP, RFC 6238: SHA-1, 30-second steps, 6 digits), checked against the published test vector.
- Required for administrators and technicians before they can use the workspace. Optional for client viewers, who can turn it on from the Account page.
- One step of clock drift is accepted either way. Each code works only once, so a used time step cannot be replayed.
- Secrets are sealed with AES-256-GCM under a 32-byte key in `data/atlas.key` (or `ATLAS_KEY_FILE`), created with mode 0600 and kept out of the database. Back up the key with the database; losing it means every user must re-enroll MFA.
- A lost authenticator is handled by an administrator reset with **Also reset two-step verification**.

## Lockout and rate limits

- 5 wrong passwords or MFA codes lock the account for 15 minutes. A lock caused by MFA failures also ends the account's sessions.
- Each address gets 10 failed sign-in, setup, or MFA attempts per 15 minutes, counted in memory.

## Sessions

- The token is 32 random bytes in an `HttpOnly; SameSite=Strict` cookie. Only its SHA-256 is stored, in the `sessions` table.
- Sessions expire after 2 hours idle or 12 hours total, with at most 10 per user. Sessions survive a server restart.
- Every state-changing request needs a per-session CSRF token header. Origin, Host, and `Sec-Fetch-Site` checks from 0.1 still apply.
- A session moves through stages: `mfa` → `password` → `mfa-setup` → `active`. Before `active`, only that stage's own endpoints are reachable.
- Forwarded identity headers are ignored.

## Security events

Stored in `security_events` and shown to administrators on the Users page. They cover setup, sign-in success and failure, lockouts, blocked sign-ins, MFA enrollment and failures, password changes, user creation and updates, and resets. Like documentation activity, this is a local table, not a tamper-evident audit trail.

## Not yet done

- Entra ID / OIDC single sign-on, passkeys (WebAuthn), and SCIM provisioning.
- Self-service password recovery. It needs email delivery; today recovery goes through an administrator.
- One-time MFA recovery codes, and a documented break-glass procedure if the last administrator loses both password and authenticator.
- A `Secure` cookie flag and HSTS. Both come with HTTPS in the deployment work. The server is loopback-only for now.
- Groups, per-record-type permissions, a separate export right, and time-limited access.
- Moving the in-memory address rate limit into shared storage once more than one server process runs.
