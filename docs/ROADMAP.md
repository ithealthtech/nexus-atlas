# Roadmap

**v1.0.0 is feature-complete.** The table records how it was built; what comes next is under *After v1*.

v1.0 is a production-ready, self-hosted documentation and password manager for an MSP and its clients. Decisions made so far:

- **Vault:** the server encrypts secrets, with a separate data key per organization protected by a master key (envelope encryption).
- **Stack:** TypeScript on PostgreSQL.
- **Hosting:** Docker on Linux, plus a Windows Server service.

| Milestone | Scope | Status |
|---|---|---|
| **M0 Foundation** | Monorepo, CI, PostgreSQL schema and migrations, Fastify API, identity (setup, scrypt, TOTP MFA, lockout, sessions), roles and per-client access, clients, React app shell with light and dark themes, Docker image and Compose stack | ✅ Done |
| **M1 Documentation** | Contacts and locations, asset layouts (flexible assets) with built-in templates, knowledge base with a rich-text editor, revisions and diffs, relationships, attachments, full-text search, Ctrl+K command palette | ✅ Done |
| **M2 Vault** | Envelope encryption, password items with TOTP, a generator, audited reveals and copies, history, per-item restrictions, one-time share links, rotation reminders, BitLocker key type | ✅ Done |
| **M3a Accounts and security** | Groups, passkeys, recovery codes, remembered browsers, session list with remote sign-out, re-confirmation for sensitive actions, SMTP email with a Microsoft 365 preset, password reset by email, expirations dashboard with alerts and a weekly digest, tamper-evident audit log with CSV export and retention | ✅ Done |
| **M3b Data in and out** | REST API with scoped API keys and an OpenAPI spec, Hudu import (idempotent re-runs), CSV import with a dry run, per-client zip exports, migration from 0.2, branding, read-only client portal with shared passwords | ✅ Done |
| **M4a Operations** | Encrypted nightly backups with retention, verified restore (including older versions), system status page, Windows service installer | ✅ Done |
| **M4b Release** | Security review and hardening tests, performance pass on a 2,000-client MSP, accessibility sweep of every screen with a keyboard walkthrough, admin and user guides, release workflow, v1.0.0 | ✅ Done |

## 2.0 and after

**2.0, the Landmark Update**, ships on 10 November 2026 with Atlas for Windows 1.0. Its scope is frozen: the [2.0 plan](https://github.com/ithealthtech/nexus-atlas/issues/229) lists what's in it. After that, a release comes out on the second Tuesday of each month, each with one headline feature (★).

| Release | Date | What's in it |
|---|---|---|
| **2.1** Safe and current | 8 Dec 2026 | ★ Safe updates that roll back by themselves; ★ "Still accurate?" document verification; keyboard shortcuts; dormant access alerts |
| **2.2** Technician speed | 12 Jan 2027 | ★ Saved list views; hover peek; recent viewers on passwords; site visit view on a phone; step-up before revealing restricted passwords |
| **2.3** Owner insights | 9 Feb 2027 | ★ Hardware lifecycle and budget forecast; documentation coverage; portfolio heatmap; reports pinned to the dashboard; Monday digest for owners; team pulse |
| **2.4** Client portal | 9 Mar 2027 | ★ Portal home page; shared reports in the portal; new starter and leaver requests; new-client onboarding tracker |
| **2.5** Compliance | 6 Apr 2027 | ★ Access review campaigns; ★ compliance evidence pack |
| **Atlas for Windows 1.1** | 12 Jan 2027 | Windows Hello before restricted reveals; jump list and Send to Atlas |
| **Atlas for Windows 1.2** | 9 Mar 2027 | ★ Recognizes the client network it's on; ★ notifications you can act on; reports in the app; signed MSIX |

Each release has a tracking issue in its [milestone](https://github.com/ithealthtech/nexus-atlas/milestones).

## Before 2.0

**Shipped since v1:** Entra ID sign-in and Microsoft 365 tenant sync; the ConnectWise RMM integration; and the BitLocker collector (see [BITLOCKER.md](BITLOCKER.md)). The changelog has the full list.

**Still ahead:** more PSA/RMM integrations (Autotask, HaloPSA, NinjaOne, Datto); network discovery; IT Glue and ITBoost importers; mobile apps; and multi-tenant cloud hosting.
