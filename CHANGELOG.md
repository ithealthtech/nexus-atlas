# Changelog

## 1.0.0 — 2026-09-24

The first production release of MSP Atlas: a self-hosted IT documentation and password manager for MSPs, on TypeScript and PostgreSQL, running on Docker (Linux) or as a Windows service.

### Documentation
- **Clients:** one workspace per client, with assets, documents, contacts, locations, and activity.
- **Asset layouts:** 13 built-in layouts (flexible assets) and your own, with 11 validated field types.
- **Knowledge base:** a knowledge base per client and an internal MSP knowledge base. Rich-text editor, templates, folders, and review dates.
- **History:** version history with line-by-line comparison and restore, and protection against overwriting someone else's edit.
- **Links and files:** relationships between any items, and file attachments stored safely.
- **Search:** full-text search with Ctrl+K, which also finds IP addresses and serial numbers.

### Password vault
- **Encryption:** envelope encryption with a data key per organization, protected by a master key that is never stored in the database.
- **Entry types:** logins with live one-time codes, and BitLocker recovery keys.
- **Password tools:** a generator, strength and reuse warnings, rotation reminders, and previous passwords.
- **Controlled access:** entries restricted to named people or groups, optional reasons for reveals, and an access history of every reveal, copy, change, and share.
- **One-time share links:** encrypted in the browser, so the server never sees the password.

### Accounts and security
- **Roles and access:** six roles, access levels per client, and groups.
- **Sign-in:** scrypt passwords, authenticator apps, passkeys, recovery codes, and remembered browsers.
- **Sessions:** a list of sessions with remote sign-out. Sensitive actions need the password again.
- **Email:** SMTP with a Microsoft 365 preset, password reset by email, expiry alerts, and a weekly digest.
- **Security log:** tamper-evident, hash-chained, with a signed checkpoint. It can be exported and has a retention setting.

### Data in and out
- **REST API** with scoped API keys and an OpenAPI description.
- **Import from Hudu:** companies, layouts, assets, articles, and passwords. Running it again updates rather than duplicating.
- **CSV import** with a dry run.
- **Exports:** per-client zip exports, with decrypted passwords only for confirmed administrators.
- **Migration** from the 0.2 prototype.
- **Branding and client portal:** your logo, accent colour, and portal welcome. Client accounts can read their own documentation and the passwords shared with them.

### Operations
- **Backups:** encrypted nightly backups with retention, one-click and command-line backups, and verified restore (including backups from older versions).
- **System status page** with plain-language health checks.
- **Windows service installer**, Docker Compose with automatic HTTPS, and automatic database migrations.

### Quality
- **Tests:** 67 server tests and 17 browser tests, with WCAG 2.2 AA checks on every screen in light, dark, and phone layouts, plus a keyboard-only walkthrough.
- **Security:** hardening tests for headers, host and origin checks, CSRF, and API key scope. A threat model is in [SECURITY.md](SECURITY.md).
- **Performance:** checked against a 2,000-client MSP with `npm run perf`.
