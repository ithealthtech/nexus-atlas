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
