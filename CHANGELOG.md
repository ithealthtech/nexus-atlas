# Changelog

All notable changes to MSP Atlas are documented here. The project follows [Semantic Versioning](https://semver.org/).

## [1.0.0] - 2026-09-24

### Added

- **Clients and documentation:**
  - Client workspaces with assets, documents, contacts, locations, and activity.
  - 13 built-in asset layouts, plus your own layouts with 11 validated field types.
  - Per-client and internal MSP knowledge bases with a rich-text editor, templates, folders, and review dates.
- **History and search:**
  - Version history with line-by-line comparison and restore, and protection against overwriting someone else's edit.
  - Relationships between any items, and safe file attachments.
  - Full-text search with Ctrl+K, including by IP address and serial number.
- **Password vault:**
  - Envelope encryption with a data key per organization, protected by a master key that is never stored in the database.
  - Logins with live one-time codes, and BitLocker recovery keys.
  - A generator, strength and reuse warnings, rotation reminders, and previous passwords.
  - Entries restricted to named people or groups, optional reasons for reveals, and an access history.
  - One-time share links encrypted in the browser.
- **Accounts:**
  - Six roles, per-client access levels, and groups.
  - Authenticator apps, passkeys, recovery codes, and remembered browsers.
  - Session management with remote sign-out, and a password re-check before sensitive actions.
- **Email:** SMTP with a Microsoft 365 preset, password reset by email, expiry alerts, and a weekly digest.
- **Data in and out:**
  - A REST API with scoped API keys and an OpenAPI description.
  - Hudu import that updates rather than duplicates on re-runs, and CSV import with a dry run.
  - Per-client zip exports, and migration from the 0.2 prototype.
- **Branding and client portal:** your logo, accent colour, and a welcome message; client accounts get read-only access to their documentation and to passwords shared with them.
- **Backups:**
  - Encrypted nightly backups with retention, plus one-click and command-line backups.
  - Verified restore, including backups from older versions.
- **Hosting:**
  - A system status page with plain-language health checks.
  - A Windows service installer, and Docker Compose with automatic HTTPS.
  - A release workflow that publishes the Docker image and a Windows package for each version tag.
- **Guides:** administrator and user guides, and a deployment guide.

### Security

- **Browser requests:** Host, Origin, `Sec-Fetch-Site`, and CSRF checks on every request; a strict Content Security Policy with no inline or third-party scripts; `__Host-` `SameSite=Strict` session cookies.
- **Sign-in protection:** scrypt password hashes, lockout, rate limits, and single-use one-time codes.
- **Audit trail:** a tamper-evident security log, hash-chained by database triggers, with a signed checkpoint.
- **API keys:** stored as hashes, limited to their scopes and to documentation and vault endpoints. They are redacted from logs, and tested against URL-encoding and dot-segment tricks.
- **Encryption at rest:** encrypted backup files, with authenticated chunks, detection of cut-off files, and a restore that checks the whole file before changing anything.
- **Uploads:** stored outside the web root, with inline display only for images that pass a content check, and a sandboxing CSP on downloads.

### Known boundaries

- **Administrators can read every password.** Atlas is not end-to-end encrypted. Reads are recorded instead.
- **Rate limiting:** failed-attempt limits are held in each server's memory. Account lockout is stored in the database.
- **Hudu importer:** it connects to any `https://` address an administrator enters, including internal ones.
- **Not in 1.0:** single sign-on, PSA and RMM integrations, a browser extension, and IT Glue or ITBoost importers.
- **Windows installer:** checked in CI, but not yet run on a production Windows Server.
