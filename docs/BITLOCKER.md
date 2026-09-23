# BitLocker integration status

User direction: stop the standalone BitLocker app and incorporate it into MSP Atlas. Use RMM deployment for the Windows collector. Do not publish a cloud service.

## Integrated now

- BitLocker navigation inside the single Atlas application.
- Sample volume inventory tied to existing client assets.
- Asset links open the same Atlas record details and documentation.
- Atlas server authorization restricts inventory to the actor's client/MSP scope.
- Imported source and RMM collector kept under `integrations/bitlocker` for continued porting.
- Explicit server-side gates on enrollment, recovery, sharing, encrypted import, and unattended ingest.

## Preserved, not yet active in Atlas

The snapshot contains browser cryptography, passphrase-wrapped enrollment keys, sharing, source schemas, enrollment and ingest logic, a read-only PowerShell collector, and an encrypted report queue. Its React/Cloudflare routes are not mounted. Shared UI dependencies from the source app are not installed here. The standalone application is retained at C:\dev\bitlocker-vault as a fallback, not a second active product.

The original agent README describes the old prototype's commands and endpoints. Do not follow its deployment sequence against this Atlas preview. Atlas intentionally offers no enrollment configuration or collection button yet.

## Current checks

The copied collector test passed in the Atlas project: mocked multi-protector collection, missing/locked-volume handling, read-only WMI allowlist, endpoint validation, no plaintext/token in report payload, RSA encryption interoperability with WebCrypto, and rejection of the wrong passphrase.

Atlas tests also cover synthetic BitLocker client isolation and rejected collection/secret-storage requests. These do not establish that production enrollment or ingestion works.

The source prototype's `tests/agent-api.mjs` remains unverified after the handoff's Wrangler HTTP 503 failures. It is not an Atlas test and is not included in `npm run check`. No live machine, recovery password, RMM deployment, or enrollment was used here.

## Remaining integration sequence

1. Finish Atlas identity, permission grants, and the reviewed shared-vault key design.
2. Port enrollment/storage/ingest to Atlas repositories, deriving client/asset assignment from enrollment, never caller-supplied tenant labels or Sites identity headers.
3. Test transactional ingestion, duplicate and stale reports, revoked tokens, client boundaries, wrong machine binding, queue retries, and historical protector preservation against Atlas's own HTTP server.
4. Port browser unlock/reveal and scoped recovery sharing with explicit key lifecycle and recovery rules.
5. Sign and package the RMM collector, validate HTTPS-only ingress, perform backup/restore and security review, then pilot on explicitly authorized Windows endpoints.
