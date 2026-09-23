# BitLocker integration handoff — 2026-09-23

The user explicitly requested: "Lets stop here and merge this project into the MSP documentation manager." Standalone BitLocker development is stopped. MSP documentation manager is the destination/owning application.

## Source and scope
Source snapshot: C:\dev\bitlocker-vault, copied into integrations/bitlocker. Original is preserved as a fallback. This folder is integration source/reference, not a second installed web application. It deliberately excludes node_modules, build output, local databases, enrollment configurations, encrypted report queues, credentials, and Sites project identity. Nothing was published or uploaded.

Bring these capabilities into MSP Atlas using its existing client/asset permissions, routes, storage and audit:
- Multi-client BitLocker key inventory, masked recovery/reveal, expiry/single-use/revocable sharing.
- Windows collector for RMM execution as SYSTEM (user explicitly chose RMM).
- Per-device, revocable enrollment; tenant assignment comes from server enrollment.
- Collector RSA-OAEP-SHA256 encryption with a per-enrollment 3072-bit public key. Encrypted private keys unlocked in browser with PBKDF2/AES-GCM.
- Read-only WMI collection of machine/volume/protection/encryption/recovery-protector details.
- Encrypted offline report queue and authenticated upload handler.
- Agent report import and status view; deduplication, first-machine binding, stale report rejection and rotation-history retention.

## Important integration boundaries
The source web application uses React/Vinext and Cloudflare D1. Atlas uses Node/SQLite and its own UI/authentication. Do not mount the copied routes unchanged or trust incoming oai-authenticated-user-* headers on self-hosted Atlas. Port the logic into Atlas and enforce its server-side client permissions. This snapshot includes imports of shared UI primitives from the original project that are not copied; reference C:\dev\bitlocker-vault if needed.

Keep Atlas's current prohibition on real credential storage in place until its vault design is reviewed. Integrating navigation, synthetic data, and collector source does not require enabling production secret storage.

Private Sites interactive authentication blocks unattended RMM upload. Self-hosted Atlas should implement a dedicated machine-token ingress route without weakening administrator authentication. No cloud publication is authorized; a prior Sites upload was rejected by automatic approval review and the user did not approve it.

No live BitLocker hardware was queried, no real recovery passwords were collected, no RMM deployment or endpoint enrollment was performed.

## Verification state at handoff
Passed:
- TypeScript and ESLint for changed source.
- Production build of standalone application after agent additions.
- PowerShell entrypoint syntax parsing.
- Mocked PowerShell collection: multiple recovery protectors, missing/locked-volume handling, no plaintext/token in reports, read-only method allowlist, endpoint validation.
- .NET PowerShell RSA encryption -> browser WebCrypto decryption interoperability; incorrect passphrases rejected.
- Original vault security suite passed before collector changes.

Unfinished:
- New tests/agent-api.mjs exists but its integration run is blocked by local Wrangler/Miniflare returning intermittent non-JSON HTTP 503 "worker restarted mid-request" during rapid negative-auth tests. Enrollment returned 200 before the failure. Do not claim the new agent API suite passed.
- The original vault security suite was attempted after agent changes and hit the same local proxy issue.
- No actual RMM or live BitLocker-machine validation.
- Production threat review, signing, monitoring/rate limiting, backups and identity/technician roles remain open.

The current SQL schema/migrations are reference only. Do not apply Cloudflare migrations directly to Atlas's database without porting and testing.

## Requested next work in the owning task
Continue the existing MSP documentation manager build with BitLocker as a first-class client/asset module. Integrate the source/collector, document incomplete security work honestly, test client isolation and collection workflows in Atlas's own local server, and report the merged application there. Keep one product and one development task going forward.
