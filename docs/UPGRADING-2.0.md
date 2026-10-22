# Upgrading to MSP Atlas 2.0

The Landmark Update brings 15 report types, scheduled PDF and link delivery, report alerts, client health scores,
smart paste, Wi-Fi join codes, and Atlas for Windows 1.0. Existing clients, vault entries, documents, integrations,
and personal menu choices are kept. A few old things are retired; see *What's removed* below.

## Before updating

1. Make an encrypted Atlas backup and verify it using the backup tools in [Deployment](DEPLOYMENT.md). Keep a copy
   off the server, and keep the master key separately. Record your current version and retain its installation package.
2. Check that your host meets the existing requirements: Node.js 22.12 or later and PostgreSQL 16 or later (Node.js 24
   and PostgreSQL 17 are tested too). System status now warns when either is too old. Docker users
   receive the Node runtime in the image. The Windows desktop app's setup carries its runtime.
3. Allow a maintenance window. Database migrations run automatically at startup. This release adds report shares,
   schedules, deliveries, triggers, and client health history (migrations 0038–0042).

## Install and verify

Use Administration → Updates or follow the instructions for your installation in [Deployment](DEPLOYMENT.md).
Docker users can select `ghcr.io/ithealthtech/nexus-atlas:2.0.0`. Update Atlas for Windows using its update prompt
or `AtlasForWindowsSetup.exe` from the same release; setup selects x64 or ARM64 for the computer.

After startup:

- Check System status and verify the security log.
- Sign in, open a client, and confirm assets, documents, vault reveals, and your chosen menu style.
- Open Reports, run a report, and export its PDF. Check branding under Administration → Theme.
- Before enabling scheduled delivery, check the recipients and configured email transport. Use Send now to verify
  one schedule. Public report links expose that snapshot to anyone who holds the link until it expires or is revoked.
- Reconnect the Microsoft 365 partner account once to add `Reports.Read.All` if you use the new usage report.
  The customer consent and GDAP role must also permit reports, such as Reports Reader; see [M365 GDAP](M365-GDAP.md).
- Confirm RMM and Microsoft 365 syncs, then check Atlas for Windows sign-in, search, document rendering, and updates.
- Staff can open What's new from their account menu; its welcome card appears on the dashboard until dismissed.

## What's removed

- **The Atlas 0.2 importer** (`npm run migrate-legacy`). To move a 0.2 database, migrate it with Atlas 1.8 first,
  then update to 2.0.
- **The old monthly client report.** Its **Monthly report** button is gone from the client header; the client's
  **Reports** tab, with PDFs, share links and scheduled delivery, replaces it. Old links open that tab.
- **Scripts and integrations use `/api/v1` only.** It is the supported API, described at `/api/v1/openapi.json`. The
  unversioned `/api` paths are the web app's own and can change in any release; API keys never worked there, so
  existing integrations are unaffected.

## Roll back

Keep the backup from before the upgrade. Stop Atlas before restoring. Reinstall the previous version and restore
its database and data files together with the matching master key, using [Deployment](DEPLOYMENT.md). Do not run
an older binary against a database already migrated by 2.0. Changes made after the backup will be lost on restore.
For Docker, select the previous pinned image version and restore the backup before starting it. Verify System
status, sign-in, and a vault reveal after the restore.

## Still planned

2.0's scope is fixed at what's described above. What comes next, release by release, is in the
[roadmap](ROADMAP.md#20-and-after). Windows code signing is used only when the repository's signing configuration is
set up; otherwise its installer remains unsigned, as described in [Code signing](CODE-SIGNING.md).
