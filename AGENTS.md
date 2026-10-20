# Working on MSP Atlas

Instructions for AI coding agents (Codex, Claude Code, and others) working in this repository. Read this before
changing anything. These rules come from the owner, Tyler, and apply to every task unless he says otherwise in that
task.

Two agents take turns on this repository: Codex and Claude Code. Treat the other agent's work as the owner's work.
Build on it; don't undo it.

## The most important rule: don't remove features

**Never remove, hide, replace, or quietly disable an existing feature, setting, option, or page unless the task asks
for that by name.**

- A redesign or restyle changes how things **look**, never what **exists**. Every option, menu, setting, and screen
  must still be there afterwards, in the new look.
- "Simplify", "clean up", "modernize", or "refine" are not permission to drop features.
- If keeping a feature makes a task hard, keep it anyway and say so in the PR. Ask; don't decide.
- If you believe something should go, propose it in the PR description and leave it in place.

### Protected features

These were removed by mistake before, or are features the owner relies on. Each must keep working. The e2e suite
checks several of them.

**Web app: layout and personal settings**
- **Three menu styles**, chosen per person under **Your account → Menu**: **Rail and panel** (the default),
  **Sidebar**, and **Top bar**.
  - The style is saved in the workspace preferences (`menu`; `MENU_STYLES` in `packages/shared/src/workspace.ts`).
  - The layouts are in `apps/web/src/components/AppShell.tsx`, and the picker in `MenuStylePicker.tsx`.
  - All three must work in whatever look Atlas has. **Collapse sidebar** must keep working, and phones always get the
    slide-out menu.
- **The customizable dashboard**: cards the person can show, hide, and reorder.
- **Client workspace tabs**: the main sections in one row, with the rest and the domain and SSL trackers under
  **More** (`apps/web/src/pages/client/ClientLayout.tsx`).
- **Administration → Theme**: brand name, logos, favicon, colours, sign-in page text, font size, corners, density,
  sidebar width, navigation style, and **Atlas defaults**.
- **Search or switch client** (Ctrl K) and the command palette.

**Documentation and vault**
- Assets with custom layouts, the knowledge base, runnable checklists, relationships, attachments, and document
  share links.
- The password vault:
  - password health (breach checks), rotation, and the BitLocker collector;
  - Send, personal vaults, emergency access, and vault policies;
  - restricted passwords.

**Reports**
- The report library, templates, history, needs-review filter, CSV and PDF exports, and every report type in
  `REPORT_KINDS`.

**Integrations and security**
- ConnectWise RMM sync, Microsoft 365 through GDAP, Hudu import, and ScreenConnect connect buttons.
- The security log; sign-in with MFA, passkeys, and SSO; rate limits; and per-client access checks.

**Atlas for Windows** (`apps/windows`)
- Search, the preview pane, and the Passwords, Assets, and Documents tables.
- Windows Hello lock, ScreenConnect connect, and automatic update checks with in-app install.

## How work is organized

- **One branch and one pull request per feature.** Never commit straight to `main`.
- **Never merge a pull request** unless the owner says to in that task. Opening the PR is the end of the job.
- **Fetch first.** Run `git fetch` and check `main` and the open PRs before starting, because the other agent may have
  changed things since.
- **Never discard or overwrite uncommitted work you didn't make**, in any worktree or folder.
- **Where to target:**
  - **2.0 work** (the "2.0 Landmark Update"; see issue #229 and the `2.0 Landmark Update` milestone) goes into
    `release/2.0`.
  - Fixes for the current 1.x release go into `main`.
  - Don't merge `release/2.0` into `main`; that happens once, at the 2.0 launch.
- **Changes reach production only as releases**, which the owner installs with the in-app updater. Don't deploy to
  servers or VMs unless asked.
- **Don't drive the owner's desktop.** No UI automation or test windows on his PC, because it takes over his mouse.
  Use CI, which takes screenshots of the Windows app.
- **No ConnectWise PSA integration.** ConnectWise is phasing PSA out.

## Checks before opening a pull request

```bash
npm run lint
npm run typecheck
npx prettier --check .
npm test
node scripts/build-site.mjs --check
```

- Server tests need PostgreSQL (`TEST_DATABASE_URL`). If none is available locally, CI runs them; say so in the PR.
- Change the UI → update the Playwright e2e tests (`e2e/`). They include an axe scan for **WCAG 2.2 AA**, so text
  needs at least 4.5:1 contrast.
- Change `site/*.md` → run `node scripts/build-site.mjs` and commit the regenerated `pages/`.
- Change the database schema → generate a migration with `npm run db:generate`. Never edit a released migration.
- Atlas for Windows needs .NET 10 and is built and tested in CI ("Windows client"). Open a PR to get a build.

## Releases

Only when the owner asks. Every version reference moves together; a release that bumps only the root
`package.json` is wrong.

- **Versions to change:**
  - `version` in `package.json`, `apps/server/package.json`, `apps/web/package.json`, `packages/db/package.json`,
    and `packages/shared/package.json`;
  - the internal `@atlas/db` and `@atlas/shared` dependencies in `apps/server` and `apps/web`;
  - the matching entries in `package-lock.json`;
  - `apps/extension/static/manifest.json`.
  - Leave third-party packages that happen to share the version number alone.
- **`CHANGELOG.md`:** turn `## [Unreleased]` into the new version's entry, with the date.
- **Site:** run `node scripts/build-site.mjs`.
- **Publish:** merge the release PR, then run the **Release** workflow on `main`.
- Atlas for Windows has its own version (`apps/windows/Directory.Build.props`).

## Writing style

- **Match the surrounding code**: its naming, comment density, and idioms.
- **Shared code:**
  - Validation schemas (zod) and shared types live in `packages/shared`.
  - Server services take a `Scope`, which carries the person and their access.
  - Anything sensitive writes a security-log event.
- **User-facing text and the manual**: plain, direct English. Name buttons and pages exactly as they appear.
- **`CHANGELOG.md`**: describe what changed for the people using Atlas, under `## [Unreleased]`.
