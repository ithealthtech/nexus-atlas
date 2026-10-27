# Alerting center — handoff for Claude

Last updated: 2026-10-23. Branch: `feature/alerting-center`, based on `origin/main` after release 2.1.1.

Current release status: Tyler explicitly requested **merge and release** on 2026-10-23. Version 2.2.0 is being
prepared on PR #289. Implementation commit `8c8ea7af97245113eb21cba8a7698b9cfeb5335c` passed all eight jobs in
[CI 39880146311](https://github.com/ithealthtech/nexus-atlas/actions/runs/39880146311), including the corrected
database browser test. Historical pending/failure notes below are superseded by this result. Validate the release
commit, merge PR #289, run the existing Release workflow on main, and verify the published assets. This release
contains the draft workspace; publishing rules and automatic delivery remain the next milestone.
Release review also corrected email destination readiness for a null/synthetic sample client: it now requires a
real client before checking access. A database regression test covers configured email with and without a client.

Draft PR: [#289 — Add shared email and Teams alert drafts and previews](https://github.com/ithealthtech/nexus-atlas/pull/289).
Initial implementation commit: `fd8b52616306ea2e1559de7154f38b514fac5c5c`. Continue this branch/PR; do not merge or release
without an owner request (now granted for 2.2.0 above). Check the latest PR head and CI before editing.

Implementation checkpoint: `7260d2e63da510a003ccd1708dd5be9bd36c5854`; subsequent commits fix and strengthen the
database browser test. Latest completed verification:
[CI 39879157999](https://github.com/ithealthtech/nexus-atlas/actions/runs/39879157999): **seven jobs passed**, with
only the new recovery browser scenario failing. A trace-driven test fix is now included; **check the newest PR
head's CI first**. Codex usage was above 90% at this checkpoint. All changes are on the same draft PR #289.

The browser failure was not solved by increasing timeouts: Playwright's `uncheck()` waited for a control that
React removed immediately once the unavailable selection was cleared. The trace shows the click completed,
the UI changed correctly, and the post-click checkbox-state check never returned. The test now clicks and
explicitly asserts the unavailable client/staff control disappears, then saves. This still needs CI confirmation.
Downloaded failure artifacts: `../alerting-ci-708/`; extracted trace: `../alerting-trace-708/` (outside the repo).
The earlier invalid-password fixture is already fixed, with an explicit account-creation assertion.

## Owner's request and decisions

Start expanding Email & alerts into one alerting center for **email and Microsoft Teams together**. Provide granular
rules, custom templates, previews/tests, client overrides, recipients, schedules, and delivery history. Keep this
note current so Claude can continue when Codex reaches its usage limit. This is implementation authorization;
the subsequent 2026-10-23 instruction authorizes merging this PR and publishing version 2.2.0.

- Initial assumption: administrator-managed drafts. Per-client overrides are planned, not implemented. Ownership
  preferences beyond this remain open; do not assume client self-service is authorized.
- Preserve every existing feature and setting, including SMTP/Graph email, Teams account connection and mappings,
  current alert days, weekly digest, audit retention, and transactional email.
- Use existing email delivery and the connected Microsoft Teams account. **Do not add an Azure Bot, paid hosting,
  another paid service, or a new dependency without consulting Tyler.**
- Existing trigger kinds: expiration, review, breach, and confirmed infection events. Do not expand this into an
  endpoint protection project. Do not invent event sources Atlas does not have.
- Never expose passwords, recovery keys, tokens, or secret fields in template variables or previews.
- Distinguish an email provider accepting a message from confirmed inbox delivery. Unknown Teams write outcomes
  must not be blindly retried.

## Intended rollout

1. Shared rules and custom templates for email and Teams; safe previews and rule dry runs; recipient selection,
   per-client overrides, and delivery history. Keep current delivery running until the new engine has parity and
   an explicit, tested migration that prevents duplicate notifications.
2. Acknowledgment, escalation, snoozing, maintenance windows, business hours/time zones, and richer digests.
3. Additional alerts backed by real Atlas events (backup/integration/report failures).

The first implementation checkpoint is a safe template library and rule drafting/preview foundation. Do not
describe drafts or previews as live automated delivery before the workers are wired and tested.

### Planned capabilities still to carry forward

- Overview of active/paused rules, failed deliveries, and connection health. Keep existing settings reachable.
- Visual templates with headings, tables, buttons, branding/footer, internal/client-facing variants, conditional
  overdue/resolved sections and digest rows. Clone starters, preview, test-send, publish versions and roll back.
- Staff groups, assigned technicians, approved client contacts and mapped channels. Workspace defaults and
  explicit client overrides with documented precedence and deduplication when rules overlap.
- Immediate alerts, milestone reminders, schedules/digests, local business hours, quiet hours, holidays and time
  zones. Routine digest preferences must be separate from urgent alerts.
- Repeat limits, acknowledgements, escalation, resolution follow-up, snoozing, paused clients and maintenance
  windows. Preserve existing Teams resolution threads.
- Explain why an alert fired and why recipients were chosen; per-recipient/channel outcomes and retries. Test
  sends need explicit destinations, permission checks and audit entries; unknown write outcomes need special
  handling to avoid duplicates. These are future capabilities, not enabled by the current draft workspace.

## Current implementation status

- Repository instructions read (`AGENTS.md`, `CLAUDE.md`); fetched origin and checked open PRs.
- Clean starting tree. Only unrelated open PR at start: #284, `docs/kb-starter-library`.
- Created `feature/alerting-center` from current `origin/main`.
- Implemented shared schemas, four starter templates, safe named-field rendering, and explainable rule matching.
- Added administrator-only draft storage in `orgs.settings.alerting`, using an org row lock and revision compare
  to reject stale saves. Save and preview operations write security events. No schema migration is needed yet.
- Added `/api/settings/alerting` GET/PUT and `/api/settings/alerting/preview` POST. References are checked against
  the current org and staff/client access. Previews use synthetic item data and never call a delivery provider.
- Added `/admin/alerting`, linked from Email & alerts: template library/editor, rule editor, and previews of both
  email and Teams messages. Editors clear stale preview results and prevent changes during a request.
- Demo support, template/rule unit tests, real database API tests and browser tests are included.
- Local validation: production and demo builds, extension packaging, lint, typecheck, whole-repo Prettier, site
  generation check, duplicate scan (0.87%, limit 1%), and 99 standalone tests passed. The browser flow passes with
  WCAG 2.2 AA scans in light/dark at 1440 and 390 pixels. Tested safe field insertion, both message previews,
  condition explanations, clearing stale previews, saving, returning to saved drafts, and rejecting secret fields.
- The new server API suite could not start: `ECONNREFUSED 127.0.0.1:5432` (no local PostgreSQL). It and the
  database-backed browser test must run in CI before calling the checkpoint verified.
- Dependency audit passed the high-severity threshold; one existing low Fastify advisory remains
  (`GHSA-389g-gv7q-r4x8`). No dependency changes were made.
- Fixed a discovered cache issue: successful saves now update React Query so navigating back does not initialize
  the editor from an older cached draft. The browser test covers this. An initial browser locator included an
  exact checkbox name despite its help text; the locator now matches the accessible name correctly.
- Inspected screenshots are committed in `docs/screenshots/alerting-center/`, including a fresh main-page image.
- Draft PR #289 is open and attached to the Codex task. CI is running. The initial run was
  [39876258581](https://github.com/ithealthtech/nexus-atlas/actions/runs/39876258581); the logging follow-up starts a
  newer run, so use the PR's latest checks rather than assuming the first run is current.
- Final privacy review: added `alerting` to private request-log paths so verbose diagnostics cannot store custom
  messages or previews. Existing request-log redaction tests now cover both new endpoints.
- Draft audience selections remain visible when a client is deleted or a staff member becomes ineligible, so
  administrators can remove the stale selection and save again. The database browser test covers this recovery.
- CI run [39876464703](https://github.com/ithealthtech/nexus-atlas/actions/runs/39876464703) passed **all eight jobs**
  for commit `0cac8484dd378f51999050dec6b31b875a60c022`, including PostgreSQL 16/17, both browser suites, Docker,
  Linux services, Windows build and Windows client. The audience-recovery follow-up still needs its own latest CI
  result recorded. The request-log redaction unit test also passed locally (100 local standalone tests in total).
- Remaining before calling the checkpoint verified: address any CI failures and record the result below.
- Run [39877563536](https://github.com/ithealthtech/nexus-atlas/actions/runs/39877563536), code commit
  `7260d2e63da510a003ccd1708dd5be9bd36c5854`: seven jobs passed; the browser test failed in its added recovery
  fixture because the password contained the test account's email name. Account creation was rejected, so an
  undefined recipient ID led to a 400. The fixture now uses a valid password and asserts account creation succeeds
  before proceeding. Local `checkPassword` validation and lint passed; the follow-up CI run must verify recovery.

### Explicitly not wired yet

No draft is live. Existing workers do not read `orgs.settings.alerting`. No publish/version rollback, common
delivery queue/history, recipient groups, client-facing recipients, custom schedules/digests, acknowledgement,
escalation, or client override precedence is implemented yet. Client selection is a filter, not an override engine.
Do not confuse a `revision` used for save conflicts with template version history. Due dates in previews are
relative to a fixed synthetic June 1, 2030, not live item data.

### New files to read first

- `packages/shared/src/alerting.ts`: schemas, safe parser/renderer, rule matcher, synthetic sample values, starters.
- `apps/server/src/services/alerting/workspace.ts`: org isolation, revision compare, transactional security log.
- `apps/server/src/services/alerting/preview.ts`: synthetic previews, recipient access and connection checks.
- `apps/server/src/routes/alerting.ts`: administrator endpoints (not allowed for API keys).
- `apps/web/src/components/alerting/`: library, editors, preview, and editor state hook.
- `apps/web/src/pages/Alerting.tsx`: page, reached from the existing Email & alerts page.
- `packages/shared/test/alerting.test.ts`, `apps/server/test/alerting.test.ts`, `e2e/alerting.spec.ts`,
  `e2e/demo/alerting.spec.ts`: behavior, permissions, concurrency, persistence and accessibility tests.
- `docs/ALERTING.md`: user-facing description with the checkpoint's limitations.

### Next implementation sequence

1. Ensure CI passes for the checkpoint, especially real PostgreSQL authorization/concurrency tests and the
   database-backed two-editor browser test. Do not skip or weaken failing checks.
2. Design publishing with immutable template/rule versions, rollback and explicit activation. Keep draft saves
   separate from published versions. Decide and test client override precedence and overlap deduplication.
3. Add a shared durable per-recipient/channel delivery queue/history with a generated migration; record event,
   rule/template version, reasons and sanitized outcomes. Snapshot content carefully, recheck recipient access
   immediately before sending, and define retention/redaction for stored message data.
4. Feed real expiration/review/breach/infection events through that queue, preserving current privacy filtering,
   Teams security channels, rate limiting, root/reply threading, reconnection pauses and uncertain outcomes.
   Use existing `MailService` and `TeamsGraph`, with no new provider. Keep transactional mail independent.
5. Implement an explicit opt-in migration from the old settings that prevents duplicate old/new sends, preserves
   notification preferences, and does not affect unrelated jobs in `Notifier`. Add real DB tests for concurrent
   workers, failures, access changes, restarts and migration before activation.
6. Add recipient groups, schedules/time zones/digests, real sample selection with safe summaries, explicit test
   sends, and the remaining first-milestone UI/history. Later: acknowledgement, escalation, snoozes/maintenance.

Previews currently check saved connection configuration only, not remote credential validity. They use actual
client names but synthetic item data. Staff are the only draft email recipients; groups/client contacts remain
pending. The new schema deliberately has no `enabled` or `published` field, so drafts cannot accidentally activate.

## Existing architecture

- `packages/shared/src/admin.ts`: existing email/notification schemas and `ExpirationItem`.
- `packages/shared/src/teams.ts`: four Teams alert kinds, account settings, channel mappings, delivery views.
- `apps/web/src/pages/Settings.tsx`: `EmailAlertsPage`, email connection form, alert days/weekly digest/retention.
  Preserve `/admin/email` and `/admin/teams` links and all current options.
- `apps/server/src/routes/admin.ts`: administrator email settings and notifications; recent authentication for
  sensitive changes. Shared schemas, `Scope`, and `securityEvent` are required for new operations.
- `apps/server/src/services/settings.ts`: org JSON settings, atomic top-level writes. Separate same-key updates
  need concurrency protection; don't silently overwrite another administrator's changes.
- `apps/server/src/services/mail.ts`: safe escaped email rendering and existing SMTP/Graph transport. Used by
  password resets, emergency access, reports, and other messages; do not globally replace or pause it.
- `apps/server/src/services/notifier.ts`: current email expiry/digest worker PLUS unrelated background jobs.
  Do not replace this worker wholesale or stop its other jobs.
- `apps/server/src/services/teams/`: settings, delegated Graph client, discussions, durable alert delivery queue.
  Current alert worker has privacy filtering, root/reply threading, throttle handling, connection pause/resume,
  and uncertain-outcome handling. Preserve these during integration.
- DB already has `teamsDeliveries` and `teamsPosts`; latest released migration is `0045_teams_graph_messages`.
  Generate new migrations, never edit released ones.

## Validation and next steps

Required before PR: lint, typecheck, Prettier, unit/server tests, site generation check; relevant build and
duplicate scan. UI changes need Playwright coverage, axe WCAG 2.2 AA, and a fresh main-page screenshot.

No local PostgreSQL or Docker was available in the preceding task. Database tests require `TEST_DATABASE_URL`;
CI provides PostgreSQL. Do not claim those tests ran locally without it. Node 24 and dependencies are installed.
Headless Edge is available; do not take over the owner's desktop. .NET 10 Windows checks run in CI.

Read this note and inspect the branch diff before continuing. Continue the current branch; don't reapply old Teams
patches in the parent workspace. Release 2.1.1 and PR #288 are already merged and published.
