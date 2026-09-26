# Changelog

All notable changes to MSP Atlas are documented here. The project follows [Semantic Versioning](https://semver.org/).

## [1.1.9] - 2026-09-26

### Changed

- **Imports put every value in a field:** the Hudu import matches integration data (Atera, ConnectWise Manage, NinjaOne, and others) and extra Hudu fields to the fields they mean, and adds a field to the layout for anything it has no field for, instead of writing device details into the notes. Re-running the import moves details out of existing assets' notes and keeps fields added since. The ConnectWise RMM sync likewise adds fields to a matched asset's layout when needed. Asset layouts can now have up to 200 fields. (#66)

## [1.1.8] - 2026-09-26

### Added

- **Check Microsoft 365 permissions:** Settings → Email has a Check permissions button that signs in to Microsoft and shows whether the app registration has the Mail.Send application permission, without sending an email. (#64)

### Changed

- **ConnectWise RMM sync updates what is already there:** a device that matches an existing asset by name or hostname (for example one imported from Hudu) updates that asset, in whichever of its fields fit, instead of creating a Configurations copy. Copies made by earlier syncs are archived and their devices moved to the existing asset. (#63)

## [1.1.7] - 2026-09-26

### Fixed

- **ConnectWise RMM sync:** devices now get their hostname, IP address, and MAC address from ConnectWise's device details, including at companies with more than one site. (#61)

## [1.1.6] - 2026-09-26

### Fixed

- **ConnectWise RMM sync:** synced devices now get their hostname, operating system, IP and MAC address, manufacturer, model, and serial number, read from each device's details in ConnectWise. Each sync notes one device's field names (never values) to help finish the mapping. (#59)

## [1.1.5] - 2026-09-26

### Fixed

- **ConnectWise RMM sync:** devices are read from every category in ConnectWise's response (platform, network, and others) and from records that hold their own device list, with more device ID names recognised. If records still lack an ID, the job note names their fields (never values). (#57)

## [1.1.4] - 2026-09-26

### Fixed

- **Microsoft 365 email:** when Microsoft refuses to send, Atlas now checks its own token and says whether the app is missing the Mail.Send *Application* permission (Delegated permissions don't work for Atlas) or is being kept from the mailbox by an Exchange access policy. A permission fixed in Entra applies on the next try instead of up to an hour later. (#56)
- **ConnectWise RMM sync:** a company with no devices (ConnectWise's "resource not found") no longer fails the sync; device lists nested deeper in ConnectWise's response are found; devices are no longer dropped when their own client ID uses a different numbering; and a company that still comes back empty gets a job note with the response's field names (never values). (#54)

## [1.1.3] - 2026-09-26

### Fixed

- **ConnectWise RMM sync:** devices are requested with the resource types ConnectWise accepts (client, company, site, then every device the key can see, filtered to the company), after a real tenant rejected the plural forms. If no request works, the sync message still shows every attempt's answer without cutting any off. (#52)

## [1.1.2] - 2026-09-26

### Fixed

- **ConnectWise RMM sync:** when devices can't be listed, the sync message shows ConnectWise's answer to every request Atlas tried and points at the API key's Devices read permission. Import messages are no longer cut off at 300 characters. (#49)

## [1.1.1] - 2026-09-26

### Fixed

- **ConnectWise RMM sync:** no longer gets the API key locked (423) by signing in on every request; one sign-in is shared and ConnectWise's slow-down responses are retried. Device lists that ConnectWise rejected (400) now try the other request formats ConnectWise uses and keep the one your tenant accepts, and sync errors include ConnectWise's own explanation. (#47)

## [1.1.0] - 2026-09-26

### Added

- **ConnectWise RMM (Asio) sync:** Import & export connects ConnectWise RMM with an API client ID and secret, links RMM companies to Atlas clients (same-name clients suggested), and syncs hourly or on demand: sites become locations, devices become Configurations assets, and devices the RMM stops reporting are archived. Still to be confirmed against a live ConnectWise tenant. (#44)
- **Sidebar client picker:** jump to any client from the sidebar. (#24)
- **Quick share:** create a one-time share link for a password straight from the list, for clients without a portal login. (#25)
- **Password list sort and grouping:** sort by name, client, type, recently changed, or needs attention; group by client or type. Remembered per browser. (#36)
- **Password folders:** per-client folders, a folder filter in the list, and a Folder field in the form. Hudu imports keep their password folders. (#37)
- **Favorites and recently used:** star passwords (personal to you) and show only favorites or the ones you last used. (#38)
- **Bulk actions:** select passwords to archive or restore them, or change rotation, client-portal sharing, or type in one go. Each is checked and audited individually. (#39)
- **Link assets from the password form.** (#40)
- **Custom fields on passwords:** up to 30 labelled values each, optionally hidden (encrypted, revealed and audited per field). Included in decrypted exports. (#41)
- **Generator presets:** Strong, Admin / service account, Easy to type, Wi-Fi / spoken, and a new PIN mode; the last settings are remembered per browser. (#42)
- **Password expiry dates:** an optional date the account stops working, shown on the password and on the Expirations page and in expiry emails. (#43)

### Fixed

- **Microsoft 365 email:** a failed test email is now logged with Microsoft's reason, and common Entra sign-in errors (secret ID instead of value, expired secret, wrong IDs, missing consent) say what to change. (#45)
- **API keys:** password folder routes now need the passwords scope. (#37)

## [1.0.3] - 2026-09-25

### Added

- **Theme manager:** Administration → Theme sets your brand name, tagline, browser title, favicon, and light and dark logos; accent and sidebar colours (with separate dark-mode colours, automatic text contrast, and readability checks before saving); text size, density, corners, sidebar width, navigation highlight style, and animations; and the sign-in page's headline, text, and background image. Changes preview live across Atlas until you save. It replaces the Branding card in Settings. (#21)

## [1.0.2] - 2026-09-25

### Added

- **Linux installer:** `deploy/linux/install-atlas.sh` installs Atlas on Ubuntu 22.04/24.04 or Debian 12 without Docker (Node.js 22, PostgreSQL 16, Caddy for HTTPS, a hardened systemd service, nightly backups). One script for every release: it installs the newest release by default, and re-running it upgrades. (#10, #19)
- **Updates:** Administration → Updates lists newer releases with their notes. On servers installed with the Linux script, an administrator can install one from there: a root-owned updater backs up, installs, and rolls back on failure. (#11)
- **Microsoft 365 email with an app registration:** sends through Microsoft Graph with OAuth2 (Mail.Send), replacing SMTP sign-in, which Microsoft is retiring for Exchange Online. System status warns while Microsoft 365 SMTP is still in use. (#16)
- **Domains assets fill themselves in:** saving a Domains asset looks up its registrar, expiry, name servers, and DNS host (RDAP and DNS), filling only blank fields. A "Refresh from domain" button re-checks. (#12)
- **Password types:** each login has a type (Domain, Microsoft 365, firewall, Wi-Fi, server, and more), guessed from its name, username, and address until you choose one. The list shows the type, the sign-in host, and linked assets, and can be filtered by type. (#15)
- **Quick actions:** copy the username, password, or current one-time code, or open the sign-in address, straight from the password list. (#17)

### Fixed

- **Hudu import:** assets now bring over their details, including data synced by integrations (RMM, PSA, Microsoft 365), fields with differently written labels, and People email addresses, not just their names. Passwords get the address saved in Hudu instead of Hudu's own link to the password, and keep their folder as a type and their link to the asset. (#14, #15, #18)
- **Key rotation:** `rewrap-keys` now also re-encrypts the SMTP password and Hudu API key (and the new Microsoft 365 client secret). (#16)

## [1.0.1] - 2026-09-24

### Added

- **Product site:** an overview, install guide, security model, and troubleshooting page at <https://ithealthtech.github.io/nexus-atlas/>.
- **Contributing guide:** setup, checks, the rules for code on the request path, and how to release.
- **Releases:** the Release workflow can be run from the Actions tab on `main`, and creates the version tag itself.

### Fixed

- **System status:** the "Backups are current" check said when the last backup finished as a raw timestamp (`2026-09-24T13:19:25.847Z`). It now says how long ago, for example "The last backup finished 9 hours ago."

## [1.0.0] - 2026-09-24

### Added

- **Clients and documentation:**
  - Client workspaces with assets, documents, contacts, locations, and activity.
  - 13 built-in asset layouts, plus your own layouts with 11 validated field types.
  - Per-client and internal MSP knowledge bases with a rich-text editor, templates, folders, and review dates.
- **History and search:**
  - Version history with line-by-line comparison and restore, and protection against overwriting someone else's edit.
  - Relationships between any items, and safe file attachments.
  - Full-text search with Ctrl+K, including by IP address and serial number.
- **Password vault:**
  - Envelope encryption with a data key per organization, protected by a master key that is never stored in the database.
  - Logins with live one-time codes, and BitLocker recovery keys.
  - A generator, strength and reuse warnings, rotation reminders, and previous passwords.
  - Entries restricted to named people or groups, optional reasons for reveals, and an access history.
  - One-time share links encrypted in the browser.
- **Accounts:**
  - Six roles, per-client access levels, and groups.
  - Authenticator apps, passkeys, recovery codes, and remembered browsers.
  - Session management with remote sign-out, and a password re-check before sensitive actions.
- **Email:** SMTP with a Microsoft 365 preset, password reset by email, expiry alerts, and a weekly digest.
- **Data in and out:**
  - A REST API with scoped API keys and an OpenAPI description.
  - Hudu import that updates rather than duplicates on re-runs, and CSV import with a dry run.
  - Per-client zip exports, and migration from the 0.2 prototype.
- **Branding and client portal:** your logo, accent colour, and a welcome message; client accounts get read-only access to their documentation and to passwords shared with them.
- **Backups:**
  - Encrypted nightly backups with retention, plus one-click and command-line backups.
  - Verified restore, including backups from older versions.
- **Hosting:**
  - A system status page with plain-language health checks.
  - A Windows service installer, and Docker Compose with automatic HTTPS.
  - A release workflow that publishes the Docker image and a Windows package for each version tag.
- **Guides:** administrator and user guides, and a deployment guide.

### Security

- **Browser requests:** Host, Origin, `Sec-Fetch-Site`, and CSRF checks on every request; a strict Content Security Policy with no inline or third-party scripts; `__Host-` `SameSite=Strict` session cookies.
- **Sign-in protection:** scrypt password hashes, lockout, rate limits, and single-use one-time codes.
- **Audit trail:** a tamper-evident security log, hash-chained by database triggers, with a signed checkpoint.
- **API keys:** stored as hashes, limited to their scopes and to documentation and vault endpoints. They are redacted from logs, and tested against URL-encoding and dot-segment tricks.
- **Encryption at rest:** encrypted backup files, with authenticated chunks, detection of cut-off files, and a restore that checks the whole file before changing anything.
- **Uploads:** stored outside the web root, with inline display only for images that pass a content check, and a sandboxing CSP on downloads.

### Known boundaries

- **Administrators can read every password.** Atlas is not end-to-end encrypted. Reads are recorded instead.
- **Rate limiting:** failed-attempt limits are held in each server's memory. Account lockout is stored in the database.
- **Hudu importer:** it connects to any `https://` address an administrator enters, including internal ones.
- **Not in 1.0:** single sign-on, PSA and RMM integrations, a browser extension, and IT Glue or ITBoost importers.
- **Windows installer:** checked in CI, but not yet run on a production Windows Server.
