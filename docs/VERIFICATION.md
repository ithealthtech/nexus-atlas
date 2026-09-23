# Verification — September 23, 2026

## Automated

`npm run check`: 7 JavaScript source/test files passed syntax validation; all 9 application test groups passed.

Coverage: MSP/client isolation for records/search/activity/export, client read-only enforcement, transactional revisions and restore, stale-edit rejection, same-client links, input validation, database reopen persistence, synthetic BitLocker scope, session/CSRF/Origin/Host restrictions, disabled secret-storage routes, and refused production startup.

`node tests/collector.mjs` from `integrations/bitlocker`: passed mocked read-only collection, multiple numerical protectors, missing/locked-volume reporting, report confidentiality, endpoint validation, randomized encryption, PowerShell-to-WebCrypto decryption, and wrong-passphrase rejection. No real BitLocker data was queried.

## Browser workflow

Verified through the local UI:

- Open the sample technician workspace.
- Create **Atlas Test Lab**, a clearly synthetic client, with a demo contact.
- Create **Test recovery procedure**, edit its content, then restore version 1 as version 3 with the full history retained.
- Create **LAB-WIN-01** and link it to that procedure.
- Search for the procedure and open linked records.
- Switch to the client viewer and verify only Harbor Dental is listed.
- Open the BitLocker module and verify sample-only state, no stored keys, and client-scoped asset links.
- Move between client-scoped assets and BitLocker without losing the selected client.
- Inspect the phone-width layout and preserve local horizontal scrolling for data tables/navigation.

The synthetic test client and records remain available for inspection. They are not real client information.

## Not verified or not implemented

Real identities/MFA, production hosting, PostgreSQL, full backup/restore, attachments, live RMM operation, actual BitLocker recovery, and the source prototype's unfinished Cloudflare agent API suite. Disabled endpoints were checked for rejection; that is not successful enrollment or ingestion validation. No deployment, upload, or repository push occurred.

# Verification — identity foundation (0.2 slice), September 23, 2026

## Automated

`npm run check`: 9 source and test files passed syntax validation, and all 16 test groups passed (7 existing store groups plus 9 new identity groups). Run on Node 22 in a Linux container.

The new coverage:

- **Passwords and TOTP:** scrypt format and salting; the RFC 6238 TOTP test vector.
- **First-run setup:** requires the console code, works only once, and forces MFA enrollment. Reloading setup keeps the same pending key. MFA secrets are stored sealed and passwords never in plain text.
- **Sign-in:** needs a password plus a fresh MFA code, and a used code is rejected. Email matching ignores case. Unknown accounts and wrong passwords get the same response. Sign-out is recorded.
- **Lockout:** after 5 failures the account locks, even for the correct password.
- **Access control:**
  - Administrators create users with scoped grants; duplicate emails and cross-MSP grants are rejected.
  - Client viewers are read-only, scoped to their clients, and must replace temporary passwords.
  - Restricted technicians can edit only granted clients.
  - Widening or narrowing access, demotion, and disabling all apply to live sessions. Resets clear MFA and end sessions.
- **Admin safeguards:** administrators cannot demote or disable themselves, and cannot reset their own password through the admin path.
- **HTTP protections:** CSRF, Origin, and Host checks; forged identity headers and fake cookies are rejected; disabled vault and BitLocker routes stay closed.
- **Persistence:** users, sessions, and MFA survive a restart with the separate key file, which is created with mode 0600.

## Browser workflow (headless Chromium through Playwright)

1. Complete first-run setup with the console code, then enroll MFA from the displayed key.
2. As the administrator, add a Harbor Dental client viewer with a temporary password, then sign out. No form content is left behind after sign-out.
3. A wrong password shows the error. The viewer then signs in, must set a new password, and sees only Harbor Dental, with no create/edit buttons and no Users page.
4. The administrator signs back in with an MFA code and opens the Manage user dialog.
5. At phone width, the page does not scroll sideways; tables and navigation scroll within their own areas.

The only console errors were the two expected 401 responses: the signed-out session check on first load, and the deliberate wrong password.

## Not verified

- Windows and Node 24 runs of the new code. The 0.1 suite was previously run there.
- A real authenticator app scanning the key. Codes were generated with the same RFC 6238 implementation, which matches the published test vector.
- HTTPS and `Secure` cookies, SSO, and passkeys. These are not implemented.
