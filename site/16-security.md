---
title: Security model
nav: Security model
out: security.html
active: security
group: Reference
order: 16
number: 16
summary: What Atlas protects, from whom, and where its protections end.
---

# Security model

Atlas holds client documentation and credentials, so its protections, and their limits, are written down.

## Every request

- **Host and Origin** must match `PUBLIC_URL`; cross-site requests are refused.
- **The session cookie** (HttpOnly, Secure, SameSite=Strict) resolves to an active session, and every change carries its CSRF token.
- **Sign-in is complete:** password, then two-step verification (required for staff), then any required password change.
- **Client access** (the highest of the person's levels and groups, capped by their role) allows the action.
- **Passwords** also need edit-and-passwords access, a place on the restriction list, and a reason where required. The reveal is recorded.

API keys replace the session with a hashed key limited to its scopes. The extension and Atlas for Windows sign in through the browser and get their own sessions.

## Threats and protections

| Threat | Protection |
|---|---|
| Stolen database or backup | Secrets are encrypted with AES-256-GCM under keys wrapped by a master key that is never in the database. Backups are encrypted too. |
| Password guessing | scrypt hashes, lockout after 5 failures, rate limits, MFA for staff, and passkeys that can't be phished. |
| Stolen session | Sessions expire after 2 hours idle or 12 hours; people can end their sessions; sensitive actions ask for the password again. |
| Cross-site attacks | Host, Origin and Sec-Fetch-Site checks, a CSRF token, and a strict Content Security Policy. |
| Over-broad access inside the MSP | Per-client access, restricted passwords, required reasons, and a record of every reveal, copy, change and share. |
| Malicious uploads | Stored outside the web root under random names; only images that pass a content check display inline. |
| Tampering with the audit trail | Events are hash-chained by the database with a signed checkpoint; **Verify now** detects edits and deletions. |
| Leaked API key | Stored as a hash, limited by scope, kept away from account, settings, backup and log endpoints, and can expire. |
| Share links and Send | Encrypted in the browser; the key is only in the link's `#` part, which the server never receives. |
| Extension or Windows app on a lost device | Neither stores passwords. Both are signed out by a password change or an administrator, and every fill or copy is recorded. |
| An administrator reading restricted passwords | Vault policies can limit restricted entries to the people listed. Emergency access is time-limited and emails the owner. Logs can stream to a SIEM. |
| A rotated password that didn't take | The vault changes only after the device confirms. Each run uses a single-use token; failures keep the old password. |

## What it doesn't protect against

> [!warning] Administrators can read every password
> Atlas is not end-to-end encrypted like a personal password manager. It records every read instead, and lets you restrict entries to named people.

- Someone who has both the master key and the database.
- A compromised server, administrator account, or signed-in person's device.
- Server-side requests an administrator sets up: the Hudu importer connects to any `https://` address, including internal ones.
- A compromised ConnectWise account. Password rotation runs scripts through ConnectWise RMM, so whoever controls it already controls those devices.

## Operating securely

- Serve Atlas only over HTTPS.
- Keep the master key in a password manager and on paper, not next to backups.
- Keep backups off the Atlas server, and check them with `npm run backup -w @atlas/server -- verify <file>`.
- Check **System status** and **Security log → Verify now** regularly.

## Reporting a vulnerability

Never in a public issue. Use GitHub's private vulnerability reporting (**Security → Report a vulnerability**) with the affected version, impact and steps to reproduce. See the [security policy](https://github.com/ithealthtech/nexus-atlas/blob/main/SECURITY.md).
