# Identity and permissions

## Roles

| Role | Staff | Maximum access per client | Admin (people, security log) |
|---|---|---|---|
| Owner | ✓ | Edit + passwords (always, every client) | ✓ (only owners can manage owners) |
| Admin | ✓ | Edit + passwords (always, every client) | ✓ |
| Technician | ✓ | Edit + passwords | — |
| Read-only technician | ✓ | Read | — |
| Client editor | — | Edit (granted clients only) | — |
| Client viewer | — | Read (granted clients only) | — |

- **Access levels:** `none`, `read`, `edit`, `edit_passwords`. Staff can also have a baseline level that applies to every client, including new ones; per-client grants can raise it.
- **Adding clients** needs edit access to every client.
- **Safeguards:** you can't change your own role or disable yourself. Admins can't create, change, or reset owners. At least one active owner must remain. A role change clamps grants to that role's maximum.

## Sign-in

- **First run:** a random setup code is printed on the server console (or set with `ATLAS_SETUP_CODE`). It creates the organization and the owner account in a single transaction, and stops working once any account exists.
- **Passwords:**
  - scrypt (N=32768, r=8, p=1) with a 16-byte salt, in the same format as 0.2, so migrated hashes keep working.
  - 12–256 characters, reasonably varied, and not containing the email name.
- **Unknown accounts:** they take the same time and get the same response as a wrong password.
- **MFA:** TOTP (RFC 6238), set up by QR code or by typing the key. Each code works once: the last-used time step is stored, and a database check stops two requests from using the same code. MFA is required for staff and optional for client accounts. Secrets are sealed with the master key.
- **Lockout:** 5 wrong passwords or codes lock the account for 15 minutes and end its sessions.
- **Session stages:** a session moves through `mfa` → `password` (temporary password) → `mfa-setup` (staff without MFA) → `active`. The server allows only that stage's own endpoints until the session is `active`.
- **Sessions:** 2 hours idle or 12 hours total, and at most 10 per user. Changing a password or enrolling MFA signs out other sessions. Disabling an account or resetting it signs out all of its sessions.

## Administration

- **Adding people:** administrators add people with a generated temporary passphrase. The person must replace it at first sign-in.
- **Reset sign-in:** issues a new temporary password, optionally resets MFA for a lost authenticator, unlocks the account, and signs the person out everywhere.
- **Security log:** records setup, sign-ins (successful, failed, and blocked), lockouts, MFA enrollment and failures, password changes, and user creation, updates, and resets, with IP addresses. Only administrators can see it.

## Coming later

- **M3:** passkeys (WebAuthn), MFA recovery codes, "remember this device", re-authentication before sensitive actions, a session list with remote sign-out, email password reset over SMTP, and a UI for groups.
- **After v1:** Entra ID / Microsoft 365 single sign-on (the provider interface and `user_identities` table land in M3).
