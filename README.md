# MSP Atlas

Self-hosted IT documentation and password manager for MSPs: client workspaces, assets, runbooks, and encrypted credentials, with per-client access for your technicians and the clients you support.

> **Status: v1.0 in development (milestones M0–M2 and M3a complete).** Sign-in with passkeys and recovery codes, permissions and groups, the documentation workspace, the encrypted password vault, email alerts, and a tamper-evident audit log work today. Import, export, and the API (M3b) and release hardening with a security review (M4) are next. Use synthetic data until v1.0. See the [roadmap](docs/ROADMAP.md).

![Atlas dashboard](docs/screenshots/dashboard.png)

| Asset | Runbook | Password |
|---|---|---|
| ![Asset detail with fields, related items, files, and version history](docs/screenshots/asset.png) | ![Runbook linked to its firewall](docs/screenshots/document.png) | ![Password entry with reveal, one-time code, share links, and access history](docs/screenshots/password.png) |

## Try the demo

`npm run build:demo -w @atlas/web` builds a clickable demo: the real web app answering API calls from sample data in the browser (`apps/web/src/demo`). Nothing is stored, and reloading starts over. Sign-in details are pre-filled and any 6-digit code works. The demo code is left out of the production build.

## What works now

- **First-run setup:** a one-time code printed in the server console lets you create the owner account and your company.
- **Sign-in:**
  - Passwords are hashed with scrypt.
  - Two-step verification uses an authenticator app with a QR code, and is required for all staff roles.
  - Accounts lock after repeated failures.
  - Sessions are stored in the database; an administrator can revoke them, and changing a password signs out other sessions.
- **People & access:**
  - Six roles: Owner, Admin, Technician, Read-only technician, Client editor, and Client viewer.
  - Each client can be set to *none / read / edit / edit + passwords*, with an "every client" baseline for staff. Groups give a team access to a set of clients in one place.
  - Changes apply to live sessions immediately.
- **Clients:** create, edit, search, and filter. Clients a user can't access look exactly like missing ones. Each client has its own workspace with Overview, Assets, Documents, Contacts, Locations, and Activity tabs.
- **Assets:** 13 built-in layouts (flexible-asset templates): configurations, networks, domains, SSL certificates, licenses, applications, backups, email, internet/WAN, wireless, printers, vendors, and remote access.
  - Administrators can add their own layouts with 11 field types, including IP address or subnet, URL, date, and choice.
  - Every field is validated on the server.
- **Documents:**
  - A knowledge base for each client, plus an internal MSP knowledge base that client users never see. Folders and templates (runbook/SOP, onboarding checklist) are included.
  - A rich-text editor with headings, checklists, tables, code blocks, and links. Content is sanitized on the server, and links are limited to http(s), mailto, and tel.
  - Status and review dates.
- **History:** every save of an asset or document is a new version. You can compare versions line by line and restore an old one as a new version. Two people editing the same record can't silently overwrite each other.
- **Relationships and files:**
  - Link assets, documents, contacts, and locations to each other.
  - Attach files by drag and drop. Only images that pass a content check display inline; everything else downloads, with a sandboxing CSP.
- **Contacts and locations:** each client can mark one primary contact and one primary location.
- **Password vault:**
  - Logins (username, password, URL, notes, and a TOTP key that shows the live one-time code) and BitLocker recovery keys. Entries link to the assets and runbooks they belong to.
  - Secrets are encrypted with a separate data key per organization, which is itself encrypted by the master key (envelope encryption). Each ciphertext is bound to its row and field.
  - The vault needs the "Edit + passwords" access level. Administrators can restrict individual entries to named people.
  - Every reveal, copy, change, and share goes into an access history. Each client can require a reason before a password is revealed.
  - A generator (random characters or passphrases), strength and reuse warnings, rotation reminders, and a history of previous passwords. Copied secrets clear from the clipboard after 30 seconds.
  - **One-time share links:** the password is encrypted in your browser, and the key lives only in the link's `#fragment`, so the server stores ciphertext it can't read. Links expire and have a view limit, which holds even if two people open the link at once.
- **Search:** Ctrl+K from anywhere finds clients, assets (including by IP or serial number), document text, contacts, and locations. It matches as you type and returns only what you're allowed to see.
- **Security log and activity:** sign-ins, failures, lockouts, and account changes for administrators. Separate activity feeds show documentation changes for each item, each client, and overall.
- **Interface:** light and dark themes, mobile layout, keyboard support, and WCAG 2.2 AA checks in end-to-end tests.

## Run it

**Production (Docker, Linux):** see [Deployment](docs/DEPLOYMENT.md). The short version:

```bash
cp .env.example .env    # set PUBLIC_URL, ATLAS_DOMAIN, POSTGRES_PASSWORD, ATLAS_MASTER_KEY
docker compose -f deploy/docker-compose.yml --env-file .env up -d
docker compose -f deploy/docker-compose.yml logs app | grep "setup code"
```

**Development** (Node 22+, PostgreSQL 16):

```bash
npm install
echo "DATABASE_URL=postgres://postgres@127.0.0.1:5432/atlas" > .env
npm run build            # builds the shared packages once
npm run dev              # API on :4318, web app with hot reload on :5173
```

## Project layout

| Path | What it is |
|---|---|
| `apps/server` | Fastify + TypeScript API: identity, authorization, clients, and documentation (assets, layouts, documents, relationships, attachments, search, activity). Serves the built web app. |
| `apps/web` | React + Vite + TanStack Router/Query + Tailwind. |
| `packages/shared` | zod schemas, roles and access levels, and API types shared by server and web. |
| `packages/db` | Drizzle schema and SQL migrations (PostgreSQL). |
| `e2e` | Playwright end-to-end tests with axe accessibility checks. |
| `deploy` | Docker Compose (Atlas + PostgreSQL + Caddy HTTPS). |
| `legacy` | The 0.2 prototype (Node + SQLite), kept for reference and for the M3 data migration. |
| `integrations/bitlocker` | BitLocker collector prototype, the reference for the post-v1 RMM collector. |

## Checks

```bash
npm run lint && npm run typecheck && npm test   # unit and integration tests (needs PostgreSQL; set TEST_DATABASE_URL)
npm run build && npm run test:e2e               # browser tests (needs E2E_DATABASE_URL pointing at an atlas_e2e database)
```

CI runs all of these on every pull request, plus a Windows build and a Docker image build.

## Docs

- [Deployment](docs/DEPLOYMENT.md): Docker, configuration, the master key, backups, and upgrades.
- [Architecture](docs/ARCHITECTURE.md): how requests, authorization, and encryption work.
- [Identity and permissions](docs/IDENTITY.md)
- [BitLocker integration status](docs/BITLOCKER.md)
- [Roadmap](docs/ROADMAP.md) and [verification log](docs/VERIFICATION.md)
