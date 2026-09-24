# Contributing

MSP Atlas holds many clients' documentation and credentials in one deployment. A mistake here
is a leaked password or one client seeing another's data, not a cosmetic bug. The bar for
changes reflects that.

## Before you start

- Security defects go through [SECURITY.md](SECURITY.md) — a private advisory, never a public
  issue.
- Read [docs/IDENTITY.md](docs/IDENTITY.md) and [SECURITY.md](SECURITY.md) before touching
  anything on the request path or in the vault.
- Open an issue first for anything beyond a doc fix or a contained bug fix.
- Never include passwords, master keys, API keys, client data, or screenshots containing
  secrets in an issue or pull request.

## Setup

Node.js 22.12 or later and PostgreSQL 16 are required.

```powershell
npm install
Set-Content .env "DATABASE_URL=postgres://postgres@127.0.0.1:5432/atlas"
npm run build
npm run dev
```

The API runs on `http://127.0.0.1:4318` and the web app with hot reload on
`http://127.0.0.1:5173`. In development a master key file is created in `data/` on first run.
`npm run build:demo -w @atlas/web` builds the clickable demo, which answers API calls from
sample data in the browser.

## Before opening a pull request

```powershell
npm run lint
npm run typecheck
npm test
npm run build
npm run test:e2e
npm audit --omit=dev
```

`npm test` needs `TEST_DATABASE_URL` and `npm run test:e2e` needs `E2E_DATABASE_URL`, each
pointing at a database the tests may erase. CI runs all of these, plus a Windows build and a
Docker image build, on every pull request.

## Rules for code on the request path

These are not style preferences. Each one closes a specific way data leaks.

1. **Check access on the server, per request.** Every client-scoped route loads its client
   through `requireClient` in `apps/server/src/authz.ts` at the level it needs. The web app
   hiding a button is never the thing keeping clients apart.
2. **Return not-found, not forbidden,** when someone asks for a client they can't access. A
   forbidden response confirms the client exists.
3. **Passwords need more than client access.** Reveals go through the vault service, which
   checks edit-and-passwords access, restriction lists, and required reasons, and records the
   read. Never return a decrypted value from anywhere else.
4. **Bind every encrypted value to where it lives.** Seal with associated data naming the
   record and field (for example `user|<id>|mfa`), so a value copied to another row fails to
   decrypt.
5. **Record security events** for sign-ins, reveals, shares, permission changes, and settings
   changes. Database triggers hash-chain the log and refuse edits and deletes; never work
   around them.
6. **Keep API keys inside their scopes.** A new route is unreachable by API keys until it is
   deliberately added to `API_ROUTES` in `apps/server/src/services/api-keys.ts`.
7. **Ship tests with the change:** an isolation test for any new client-scoped route, and a
   tamper or wrong-key test for anything that encrypts.

## Database changes

Change `packages/db/src/schema.ts`, then run `npm run db:generate` and commit the generated
SQL migration. Migrations run automatically at startup. Never edit a migration that has been
released; add a new one.

## Never commit

`.env` files, master keys, credentials, API keys, client records, databases, backups, logs,
exports, or production screenshots.

Use synthetic `.example` or `.test` domains and reserved 555 telephone numbers in tests and
documentation. Rotate any credential immediately if it may have been exposed.

## Accessibility

The Playwright gate runs axe (WCAG 2.2 AA) on every screen in light and dark themes and at
phone width, plus a keyboard-only walkthrough. UI changes must keep it green: visible focus,
labelled controls, no colour-only meaning, and no sideways scrolling at 390 px.

## Commits and pull requests

- Use a short-lived branch and keep changes focused.
- Imperative subject line, under about 72 characters.
- Explain _why_ in the body; the diff already shows what.
- Note which of the rules above your change touches, if any.
- Update [CHANGELOG.md](CHANGELOG.md) for user-visible changes.

## Releasing

1. Set the new version in every `package.json` (the root and each workspace, including the
   internal `@atlas/*` dependencies), run `npm install`, and add a `## [x.y.z]` section to
   [CHANGELOG.md](CHANGELOG.md).
2. Merge to `main` with CI green.
3. Push a tag `vx.y.z` on that commit, or run the **Release** workflow from the Actions tab on
   `main`, which creates the tag.

The workflow checks the tag against `package.json`, then publishes the Docker image to GitHub
Container Registry and a Windows package with its SHA-256 checksum to the GitHub release, with
notes from the changelog.

## Documentation

`docs/` is for operators and developers. `pages/` is the published product site at
<https://ithealthtech.github.io/nexus-atlas/>, deployed by `.github/workflows/pages.yml` when
it changes on `main`. It is plain HTML, CSS, and JavaScript with a strict Content Security
Policy: no inline scripts or styles, and no third-party assets.
