# MSP Atlas

Self-hosted IT documentation and password manager for MSPs: client workspaces, assets, runbooks, and encrypted credentials, with per-client access for your technicians and the clients you support.

> **Status: v1.0 in development (milestone M0 of 5 complete).** Sign-in, MFA, roles, per-client permissions, and client workspaces work today. Documentation (M1) and the password vault (M2) are next. Use synthetic data until v1.0. See the [roadmap](docs/ROADMAP.md).

![Atlas dashboard](docs/screenshots/dashboard.png)

## What works now

- **First-run setup:** a one-time code printed in the server console lets you create the owner account and your company.
- **Sign-in:**
  - Passwords are hashed with scrypt.
  - Two-step verification uses an authenticator app with a QR code, and is required for all staff roles.
  - Accounts lock after repeated failures.
  - Sessions are stored in the database; an administrator can revoke them, and changing a password signs out other sessions.
- **People & access:**
  - Six roles: Owner, Admin, Technician, Read-only technician, Client editor, and Client viewer.
  - Each client can be set to *none / read / edit / edit + passwords*, with an "every client" baseline for staff. Group grants are in the data model, with a UI coming in M3.
  - Changes apply to live sessions immediately.
- **Clients:** create, edit, search, and filter. Clients a user can't access look exactly like missing ones.
- **Security log:** sign-ins, failures, lockouts, MFA changes, and account administration.
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
| `apps/server` | Fastify + TypeScript API: identity, authorization, clients. Serves the built web app. |
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
