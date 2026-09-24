# Architecture

## Components

- **API (`apps/server`):** Fastify 5 and TypeScript.
  - Each request passes host and origin checks, then session resolution, then CSRF and stage checks, then the route handler, which calls the authorization functions.
  - The server also serves the built web app, with client-side routes falling back to `index.html`.
- **Web app (`apps/web`):** React 19, TanStack Router and Query, and Tailwind 4. It is built into static files, with no inline scripts or styles, so the CSP stays at `script-src 'self'; style-src 'self'`. Dialogs are native `<dialog>` elements rather than libraries that inject style tags.
- **Database (`packages/db`):** PostgreSQL 16 through Drizzle ORM. SQL migrations live in `packages/db/drizzle` and are generated with `npm run db:generate`. On start, migrations run under an advisory lock.
- **Shared code (`packages/shared`):** zod schemas, roles and access levels, and API types. The same validation runs in the browser (for messages) and on the server (for enforcement).

## Documentation model

- **Tables:** `contacts`, `locations`, `asset_layouts` (field definitions as JSON), `assets` (field values as JSON, validated against the layout), `documents` (TipTap/ProseMirror JSON plus extracted plain text), `folders`, `revisions`, `relations`, `attachments`, and `activity`.
- **Versions:**
  - Assets and documents carry a `version`. An update must send the version it started from, and the database `UPDATE … WHERE version = ?` returns a 409 conflict if someone saved in between.
  - Each save writes a snapshot to `revisions`. Restoring saves an old snapshot as a new version, so history is never rewritten.
- **Rich text:** the server rebuilds each document from an allowlist of node and mark types and attributes (`services/richtext.ts`), and rejects unknown content and unsafe links. The browser renders through the same editor schema, never as raw HTML. The editor loads on demand and runs with CSS injection turned off, so the CSP stays strict.
- **MSP knowledge base:** documents with no client belong to the MSP. Staff can read them; technicians and admins can edit them; client accounts never see them. They may link to any client's items, but a client viewer never sees a link to MSP-internal content.
- **Relationships:** a link is stored once, as an unordered pair. Items can link only within the same client, or from an MSP article to a client item. When listed, links are filtered by the viewer's access.
- **Attachments:** files are streamed to storage (`LocalStorage` under `ATLAS_DATA_DIR/attachments`, with the same interface ready for S3) while being hashed and size-limited. A file cut off at the limit is deleted and refused.
  - Filenames are cleaned and stored only as text.
  - Only PNG, JPEG, GIF, and WebP files that pass a first-bytes check get an image content type and can display inline.
  - Everything else downloads as `application/octet-stream`, with `Content-Disposition: attachment` and `CSP: sandbox`. Access follows the item the file is attached to.
- **Search:** generated `tsvector` columns with GIN indexes, plus `pg_trgm` indexes on names for fuzzy matching.
  - Input becomes a prefix query (`'harb':* & 'fire':*`), so results appear as you type, and is always passed as a bound parameter.
  - One query combines assets, documents (with `ts_headline` snippets), contacts, locations, and clients, limited to the clients the user can read (plus the MSP knowledge base for staff).

## Password vault

- **Envelope encryption** (`crypto/vault-keys.ts`):
  - Each organization gets a random 256-bit data key, stored only in encrypted form, under the master key, in `vault_keys`.
  - Secret fields (password, notes, TOTP key, previous passwords) use AES-256-GCM, with associated data naming the row and field (`pw|<id>|secret`, `pwh|<historyId>`). A ciphertext copied into another row or field won't decrypt.
  - `npm run rewrap-keys` re-encrypts data keys under a new master key.
- **Reuse detection:** a keyed HMAC of each secret (the key is derived from the organization's first data key) lets Atlas spot the same password used twice without storing anything reversible. Strength is a rough score used for guidance only.
- **Access:**
  - Vault entries need `edit_passwords` on their client. Restricted entries also need an administrator or a place on the entry's allow-list. Everyone else gets 404.
  - Search and relationship lists apply the same rule, and match only names, usernames, and URLs, never secrets.
- **Audit:** each reveal, copy, TOTP view, change, share, and restriction change goes into `vault_audit`, with the person, IP address, and optional reason. A client setting (`require_reveal_reason`) makes the reason mandatory.
- **Share links:**
  - The browser reveals the secret (which is audited), encrypts it with a fresh AES-GCM key using WebCrypto, and uploads only the ciphertext.
  - The key goes in the link's `#fragment`, which browsers never send to the server. The server stores a hash of the link token.
  - Opening a link is one atomic `UPDATE … WHERE views < max_views AND expires_at > now()`, so a one-view link opens once even under concurrent requests.
  - The recipient page removes the key from the address bar before doing anything else.
- **Files and the vault:** attachments aren't encrypted at rest, so they can't be attached to vault entries.

## Authorization

The code is in `apps/server/src/authz.ts`.

- **Effective access:** a user's access to a client is the highest of three things: their baseline for every client, a direct grant for that client, and any group grants. The result is capped by their role; for example, a read-only technician is always capped at `read`. Owners and admins always have `edit_passwords`.
- **Access checks:** every client-scoped operation calls `requireClient(actor, clientId, level)`.
  - No access returns **404**, the same as a missing client, so you can't probe which clients exist.
  - Read-only access to an operation that needs edit returns **403**.
  - Client IDs are validated as UUIDs before any query runs.
- **Fresh on every request:** the actor is rebuilt from the database for each request, so role and grant changes and disabled accounts take effect without waiting for a sign-out.
- **No trusted identity from the request:** tenant (`org_id`) and identity never come from request bodies or headers.

## Encryption

The code is in `apps/server/src/crypto/keys.ts`.

- **Format:** AES-256-GCM, written as `v2:<keyId>:<iv>:<tag>:<ciphertext>`.
- **Associated data:** each value is bound to where it belongs, for example `user|<id>|mfa`, so a value copied into another row fails to decrypt.
- **Keys:** a `KeyProvider` supplies master keys from the environment or a key file and supports several keys for rotation. Cloud key managers (Azure Key Vault, AWS KMS) can implement the same interface.
- **M2 vault:** the vault adds per-organization data keys, encrypted under the master key (envelope encryption), for password fields.

## Request security

- **Host and Origin:** the Host header must match `PUBLIC_URL`, which protects against DNS rebinding; loopback is also allowed outside production. Origin must match when present, and cross-site `Sec-Fetch-Site` requests are refused.
- **Cookies:** `__Host-atlas_session`, set as `HttpOnly; Secure; SameSite=Strict` when served over https. The database stores only a SHA-256 of the session token.
- **CSRF:** each session has its own token, sent in the `X-CSRF-Token` header on every state-changing request.
- **Headers:** CSP, HSTS (over https), `X-Frame-Options: DENY`, COOP/CORP, `nosniff`, `no-referrer`, and `Cache-Control: no-store` on API responses.
- **Rate limits:** each client address gets 10 failed sign-in, setup, or MFA attempts per 15 minutes, on top of the per-account lockout.
- **Error handling:** validation errors return field-level messages, and unexpected errors are logged and returned as a generic 500.
