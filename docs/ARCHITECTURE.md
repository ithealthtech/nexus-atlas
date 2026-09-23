# Architecture and trust boundaries

## Current implementation

The first slice is deliberately a local, synthetic-data application. Native Node HTTP and SQLite keep setup reproducible without Docker or database services on this machine. There is no bundler, framework compilation, dependency installation, or implied production readiness. Browser code is served from an explicit four-file allowlist.

`server/app.mjs` owns requests, Origin/Host checks, CSRF verification, sign-in stage gating, and the static allowlist. `server/identity.mjs` owns accounts, password hashing, MFA, sessions, role and client grants, and security events; see [identity and permissions](IDENTITY.md). `server/store.mjs` owns data validation and authorization and derives access from a server-created actor. Every client lookup requires MSP ownership and, for a restricted actor, client membership. Record access delegates to that client check. Relationships authorize both endpoints and require matching clients. Exports, activity, and search honor the same scope.

All data-modifying record operations and revision snapshots run in transactions. Updates require the current version. Restore creates a new revision instead of erasing history. Actor and tenant fields cannot be supplied through record request bodies. Prepared statements bind values.

The browser escapes record values before rendering, does not render arbitrary HTML/Markdown, and uses a restrictive CSP without inline scripts. Documents currently support text and heading lines, not a full rich-text editor. Credential-like values in free text cannot be reliably recognized; this is one reason the preview must contain synthetic information only.

## Identity

The demonstration personas are gone. Every request resolves a database-backed session to a user, and the actor (role and client grants) is rebuilt from the database on each request, so access changes apply immediately. Details and remaining gaps are in [IDENTITY.md](IDENTITY.md).

The server binds to 127.0.0.1. Host is restricted to loopback names with the actual port. Production mode throws. Those are development safeguards; an administrator could still expose a loopback service with a proxy. Never deploy this slice or enter real client data.

## Vault and BitLocker gate

No vault schema, real recovery-key store, decryption UI, or active agent token system exists in Atlas. Vault operations return 501. BitLocker enrollment/import/reveal/sharing return 501, and machine ingress returns 503 before reading a report body. No report is acknowledged as accepted. The imported BitLocker Cloudflare source is not executable through Atlas's static paths or HTTP routes.

The synthetic BitLocker inventory derives its client from an authorized asset. It contains no secret, ciphertext, passphrase, private key, or enrollment credential. Collector/crypto tests use synthetic keys and mocked WMI only.

## Production design still required

1. Add an external identity provider (Entra ID/OIDC), passkeys, and a documented administrator break-glass procedure on top of the local accounts now in place.
2. Move persistence behind an explicit repository adapter to PostgreSQL; version migrations and test row policies using actual app/worker database roles.
3. Specify the vault key hierarchy and protocol for devices, collections, sharing, membership changes, recovery, and encrypted attachments. Obtain cryptographic review before implementing production secret flows.
4. Define BitLocker device enrollment, revocable machine-token ingestion, first-device binding, idempotency, stale-report handling, rotation history, rate limits, and least-privilege ingress independently from interactive technician sessions.
5. Implement encrypted backups, full restore exercises, protected audit exports, operational monitoring, upgrades, packaging, and an independent security assessment.

The copied BitLocker prototype's per-record/enrollment passphrases are reference behavior, not an approved organization-wide vault key hierarchy. Importing its source does not establish production interoperability, security approval, or successful end-to-end RMM ingestion.
