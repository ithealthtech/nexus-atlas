# Security policy

MSP Atlas holds client documentation and credentials, so its security model is written down here. The details of each mechanism are in [Identity and permissions](docs/IDENTITY.md), [Architecture](docs/ARCHITECTURE.md), and [Deployment](docs/DEPLOYMENT.md).

## Supported versions

Only the latest stable MSP Atlas release receives security fixes. The 0.1 and 0.2 prototypes in `legacy/` and the clickable demo build are not supported for production use.

## Reporting a vulnerability

Do not disclose a suspected vulnerability in a public issue. Use GitHub's private vulnerability reporting feature for this repository (Security → Report a vulnerability) and include the affected version, impact, and reproducible steps. You'll get an acknowledgement within three working days.

## Security expectations

- Never commit `.env` files, master keys, credentials, API keys, client records, databases, backups, logs, or production screenshots.
- Use synthetic `.example`/`.test` domains and reserved 555 telephone numbers in tests and documentation.
- Rotate any credential immediately if it may have been exposed, and rotate the master key if a key file may have been.
- Review `npm audit --omit=dev` and the CI results before every release.

## What Atlas protects, and from whom

| Threat | Protection |
|---|---|
| Stolen database or database backup | Passwords, notes, one-time code keys, MFA secrets, and the SMTP and Hudu credentials are encrypted with AES-256-GCM. Each value is bound to its row and field. The keys are wrapped by a master key that is never stored in the database. Backup files are encrypted with a key derived from the master key. |
| Password guessing and credential stuffing | scrypt password hashes; lockout after 5 failures; per-address rate limits; MFA required for staff (authenticator app or passkey); passkeys can't be phished. |
| Stolen session | `HttpOnly`, `Secure`, `SameSite=Strict`, `__Host-` cookies; sessions expire after 2 hours idle or 12 hours; people can see and end their sessions; sensitive actions need the password again within 10 minutes. |
| Cross-site attacks | Host and Origin checks against `PUBLIC_URL`, `Sec-Fetch-Site` checks, a per-session CSRF token on every change, and a strict Content Security Policy (no inline or third-party scripts, no framing). |
| Over-broad access inside the MSP | Per-client access levels, restricted passwords for named people and groups, optional reasons for reveals, and an access history of every reveal, copy, change, and share. |
| Malicious uploads | Files are stored outside the web root under random names. Only images that pass a content check display inline; everything else downloads with a sandboxing CSP. |
| Tampering with the audit trail | Security events are hash-chained by database triggers that refuse edits, with a checkpoint signed by a key derived from the master key. Verification detects edited, reordered, and deleted events. |
| Leaked API key | Keys are stored as hashes. Scopes limit what a key can do, and passwords need their own scope. A key can't reach account, people, settings, backup, or log endpoints, and can expire. Every use is recorded. |
| One-time share links | The password is encrypted in the browser. The key lives only in the link's `#fragment`, which the server never receives. |

## What Atlas does not protect against

- **Someone with the master key and the database together.** They can decrypt everything, so keep the key separate from database backups. See [the master key](docs/DEPLOYMENT.md#the-master-key).
- **A compromised server or administrator account.** An administrator can read every password (and every read is logged), and the server process holds the keys in memory. Atlas is not end-to-end encrypted like a personal password manager.
- **A compromised browser or device** of someone who is signed in.
- **Server-side requests made for administrators.** The Hudu importer connects to whatever `https://` address an administrator enters, including addresses on your internal network. Only administrators can set it.
- **Rate limits across several servers.** Failed-attempt counters live in each server's memory. Account lockout is stored in the database and applies everywhere.

## Operating it securely

- Serve Atlas only over HTTPS (`PUBLIC_URL` must be `https://` in production), behind a reverse proxy with `TRUST_PROXY=true`.
- Keep the master key in a password manager and on paper, not next to backups. Keep an old key after rotating for as long as you keep backups made with it.
- Keep backups off the Atlas server (a share, a NAS, or cloud storage), and check them with `npm run backup -- verify <file>`.
- Check **System status** and **Security log → Verify now** regularly.
- Update Atlas when new versions are released. `npm audit --omit=dev` runs in CI on every change.
