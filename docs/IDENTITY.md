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
- **Second step (MFA):** an authenticator app, a passkey, or both. MFA is required for staff and optional for client accounts.
  - **Authenticator app:** TOTP (RFC 6238), set up by QR code or by typing the key. Each code works once: the last-used time step is stored, and a database check stops two requests from using the same code. Secrets are sealed with the master key.
  - **Passkeys (WebAuthn):** Windows Hello, Touch ID, phones, or security keys. A passkey can be the second step after the password, or sign someone in on its own when it verifies them (PIN or biometrics). Staff can enroll a passkey instead of an authenticator app. The relying party is the `PUBLIC_URL` host name, so passkeys need a host name (not an IP address). Up to 10 per person.
  - **Recovery codes:** 10 single-use codes are issued with the first second factor and shown once. They are stored as SHA-256 hashes and removed atomically when used. People can replace them from their account page.
  - **Remember this browser:** after the second step, a person can skip it on that browser for 30 days. The browser keeps a random token in an `HttpOnly` cookie; the server stores only its hash. People see and remove remembered browsers on their account page, and an MFA reset removes them all.
- **Lockout:** 5 wrong passwords or codes lock the account for 15 minutes and end its sessions.
- **Session stages:** a session moves through `mfa` → `password` (temporary password) → `mfa-setup` (staff without MFA) → `active`. The server allows only that stage's own endpoints until the session is `active`.
- **Sessions:** 2 hours idle or 12 hours total, and at most 10 per user. Changing a password or enrolling MFA signs out other sessions. Disabling an account or resetting it signs out all of its sessions. People see where they are signed in and can sign out any other session; administrators can sign someone out everywhere.
- **Confirming it's you:** changing people, groups, email settings, passkeys, or recovery codes, and exporting logs, need the password to have been entered in the last 10 minutes. The app asks for it and then continues.
- **Forgotten passwords:** when email is set up, the sign-in page offers a reset link. The response is the same whether or not the account exists, and at most 3 links are sent per account per hour. A link works once, expires in an hour, and carries its token in the URL fragment so it never reaches server logs. Using it signs the person out everywhere and emails them a notice. Two-step verification still applies at the next sign-in.

## Administration

- **Adding people:** administrators add people with a generated temporary passphrase. The person must replace it at first sign-in.
- **Reset sign-in:** issues a new temporary password, optionally resets MFA for a lost authenticator, unlocks the account, and signs the person out everywhere.
- **Groups:** give members per-client access in one place. A member's effective level is the highest of their baseline, their own grants, and their groups' grants, then capped by their role. Groups are for staff; client accounts get access individually. Restricted passwords can list groups as well as people.
- **Security log:** records setup, sign-ins (successful, failed, and blocked, and which second step was used), lockouts, MFA and passkey changes, recovery code use, password changes and resets, remembered devices, session sign-outs, user and group changes, email settings, and log exports, with IP addresses. Only administrators can see it.
- **Tamper evidence:** a database trigger chains every security event to the previous one with SHA-256, and another trigger refuses edits. **Verify now** on the Security log page recomputes the chain. A checkpoint of the newest event, signed with a key derived from the master key, is refreshed hourly and on each verification, so deleting the newest events is also detected. Someone with full database access can still rebuild the chain, but not the signed checkpoint without the master key.
- **Retention and export:** security and password-activity logs can be kept forever (the default) or for 1–7 years, and exported as CSV (cells that spreadsheets would treat as formulas are neutralised).

## API keys and client accounts

- **API keys:** administrators create them and each key acts as its creator, limited to the scopes it was given (`read`, `write`, `passwords`) and to documentation and vault endpoints. Creating, revoking, and using keys are recorded. See [Data in and out](DATA.md#rest-api).
- **Client accounts** see only the clients they're granted. They see a password only when staff share it with the client, never restricted ones, and reveals follow the same reason and access-history rules as staff.

## Coming later

- **After v1:** Entra ID / Microsoft 365 single sign-on.
