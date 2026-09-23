# Keyhaven — MSP BitLocker vault

A private pilot for organizing encrypted recovery passwords by client tenant. Start with the labeled sample workspace or open the persistent vault.

## Implemented
- Search/filter/paginate device records for a 100–1,000-device inventory.
- AES-256-GCM browser encryption, random salt/IV per record, PBKDF2-SHA256 (600,000 iterations).
- No recovery passwords or vault passphrases stored by the server. Metadata (device, user, client, key identifier) is not application-encrypted.
- Authenticated-user isolation on all device/list/share-management operations.
- Sharing: separate passphrase, 256-bit random URL token in fragment, hashed token in database, 15/60/240-minute expiry, atomic one-time consumption, revocation. Opening consumes the link before decryption; incorrect passphrases can be retried only in the open recipient page.
- Audit events omit key ciphertext and passwords. Last 200 events shown.
- Reveal hides at 60 seconds, browser vault passphrase clears at five minutes.

## Pilot boundaries
The published site is owner-private. Recipients must have platform site access; recipient email is an audit label, not an identity restriction. No Entra/RMM integration, technician roles, tenant-specific delegated permissions, automatic escrow/rotation, passphrase recovery, immutable external audit sink, or backup/restore interface is implemented. The vault currently supports a single administrator per isolated user workspace; client tenants are organizational groups, not independently authenticated accounts. Keys can have distinct passphrases; retain the correct passphrase for each key. Losing it loses access. Clipboard contents are not automatically erased.

Do not use this pilot as the sole escrow for production recovery keys. Complete identity, key lifecycle, backup/restore, operational monitoring, and independent security review before production rollout.

## Development
Node 24, npm ci. npm run dev / npm run build. Database schema is in db/schema.ts; generated migrations under drizzle. Use the Sites local migration workflow before local API testing. Site hosting enforces authentication at its dispatcher; never expose the Worker directly where callers can forge authenticated-user headers.

Checks: TypeScript noEmit, ESLint for app/lib/db source, production build, and node tests/security.mjs against a local built Worker on 4188. Tests create isolated fake data only in the local test database. The security test must not target production.

No real client data is bundled. Sample inventory is UI-only and has no recovery passwords.
