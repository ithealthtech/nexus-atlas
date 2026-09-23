# Roadmap to v1.0

v1.0 is a production-ready, self-hosted documentation and password manager for an MSP and its clients. Decisions made so far:

- **Vault:** the server encrypts secrets, with a separate data key per organization protected by a master key (envelope encryption).
- **Stack:** TypeScript on PostgreSQL.
- **Hosting:** Docker on Linux, plus a Windows Server service.

| Milestone | Scope | Status |
|---|---|---|
| **M0 Foundation** | Monorepo, CI, PostgreSQL schema and migrations, Fastify API, identity (setup, scrypt, TOTP MFA, lockout, sessions), roles and per-client access, clients, React app shell with light and dark themes, Docker image and Compose stack | ✅ Done |
| **M1 Documentation** | Contacts and locations, asset layouts (flexible assets) with built-in templates, knowledge base with a rich-text editor, revisions and diffs, relationships, attachments, full-text search, Ctrl+K command palette | ✅ Done |
| **M2 Vault** | Envelope encryption, password items with TOTP, a generator, audited reveals and copies, history, per-item restrictions, one-time share links, rotation reminders, BitLocker key type | Next |
| **M3 Admin and scale** | Groups UI, passkeys, recovery codes, SMTP notifications, expirations dashboard, tamper-evident audit log, REST API with API keys, CSV and IT Glue import, exports, migration from 0.2, branding, client portal | |
| **M4 Release** | Windows service installer, scheduled encrypted backups and restore, status page, performance and accessibility pass, security review, admin and user guides, v1.0 | |

**After v1:** Entra ID / Microsoft 365 SSO and tenant sync; PSA/RMM integrations (ConnectWise, Autotask, HaloPSA, NinjaOne, Datto); a browser autofill extension; the BitLocker RMM collector (from `integrations/bitlocker`); network discovery; a Hudu importer; mobile apps; and multi-tenant cloud hosting.
