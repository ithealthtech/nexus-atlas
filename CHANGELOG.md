# Changelog

All notable changes to MSP Atlas are documented here. The project follows [Semantic Versioning](https://semver.org/).

## [1.7.5] - 2026-09-30

### Fixed

- **ConnectWise RMM sync fills the right device fields.** The manufacturer now comes from the device's baseboard maker (Dell, Lenovo, HP) and goes into the Manufacturer field, instead of the BIOS vendor or an extra field. Last check-in comes from ConnectWise's heartbeat, and endpoint protection from the device's antivirus list and antivirus services, so both now show on assets and the RMM health charts. The device list follows ConnectWise's paging, asks 500 devices at a time, and reads each device from its own site. Field names follow ConnectWise's published platform API spec. (#124)

## [1.7.4] - 2026-09-30

### Added

- **Warranty lookup by serial number.** Dell, Lenovo and HP devices get their warranty end date from the vendor's public warranty check, with no API keys to set up. It is looked up when a device with a serial number and no warranty date is saved, and during the ConnectWise RMM sync for devices the RMM gives no date for. A date someone typed in is never replaced. Each asset has a **Check warranty** button that looks it up right away, and Settings, Asset warranty can turn automatic lookups off. (#122)

## [1.7.3] - 2026-09-30

### Fixed

- **Hudu imports no longer duplicate clients.** A Hudu company imported for the first time now links to the Atlas client with the same name (ignoring case, spacing and punctuation) and updates it, instead of adding a second client. Clients added by hand or from ConnectWise RMM are matched this way. Duplicates made by earlier imports can be merged on the Duplicates page. (#118)

## [1.7.2] - 2026-09-30

### Fixed

- **ConnectWise tickets now sync.** The ticket dashboard asked for tickets at addresses the ConnectWise platform doesn't have, so every sync reported "No tickets listed". It now reads the platform's service ticketing API (`/api/platform/v2/service/ticketing/tickets`), tells closed tickets apart by the status's Closed category, and links each ticket to its page in the ConnectWise web app (North America; the company needs its numeric company ID mapped). (#98)
- **ConnectWise RMM devices show whether they're online.** Device records don't carry it, so every device counted as online unknown. The sync now reads each company's agent availability from the platform heartbeat API (`/api/platform/v2/device/endpoints/heartbeat`).

## [1.7.1] - 2026-09-30

### Fixed

- **ConnectWise RMM devices are saved as device assets, not Configurations.** The sync saves new devices in a layout named Devices or Device assets when there is one (or the layout chosen under *Save devices in*), updates same-named assets already in it instead of adding copies, and moves devices an earlier sync put in Configurations (or in a layout chosen before) there, keeping what was entered on them. Restoring a version from before the move puts the asset back in its old layout. Only assets the sync made are archived when their device goes away. Configurations is still used when there is no device layout.

## [1.7.0] - 2026-09-30

### Added

- **Atlas for Windows (preview):** a tray app for technicians. Ctrl+Shift+Space opens quick search over the clients, assets, documents, and passwords you can see; copy a username, password, or one-time code (recorded like a reveal, and cleared from the clipboard after 30 seconds, never kept in clipboard history), open the sign-in address, or open the record in Atlas. It signs in through your browser with your usual password and second step or passkey, keeps only a DPAPI-protected session token, and can start with Windows and remind you about items expiring in the next 14 days. Signed MSIX packages and automatic updates come next. (#23)
- **Desktop app sign-in:** the authorization code flow with PKCE and a loopback redirect, issuing app sessions with `read`, `write`, and `reveal` scopes. Signed-in apps are listed on the Account page, where they can be signed out, and end with every other kind of sign-out. (#23)
- **Quick search API:** `GET /api/v1/search` takes a `limit`, for as-you-type use. (#23)
- **Vault policies:** a new Administration → Vault policies page. It shows that MFA is required for staff and lists anyone who can reach passwords without it. The owner can set the password generator's minimum length and required numbers or symbols (and turn off PINs), require a reason for every reveal in every client, stop read-only accounts from revealing passwords, and make restricted passwords available only to the people listed on them, administrators included. (#35)
- **Emergency access:** the owner names trusted administrators, each with a waiting period. A trusted administrator can request access to every restricted password; the owner is emailed at once and can deny it during the wait or approve it sooner. Access lasts 24 hours, every step is in the security log, and each password used is marked "Emergency access" in its access history. (#35)
- **SIEM streaming:** send the security log and the password access log to a SIEM as they happen, by HTTPS webhook (JSON, optionally HMAC-signed) or syslog (RFC 5424 over TLS, TCP, or UDP). Failed sends are retried from where they stopped. (#35)
- **Browser extension for Edge and Chrome:** suggests the logins saved for the site you're on and fills them, with a quick search to copy a password, username, or one-time code for any login you can use. It signs in through Atlas: you approve the browser in Atlas after checking a code, and the extension gets a session tied to a key that never leaves the browser. It stores no passwords and asks Atlas each time. Fills and copies are recorded like reveals, and clients that require a reason ask for one. Signed-in browsers are listed on your account page, end after 7 days unused or 30 days in total, and are signed out with everything else when your password changes or an administrator signs you out. Build it with `npm run build:extension`. (#28)
- **Asset statistics:** a card on the dashboard and each client's overview with servers, workstations, switches, network devices, printers, and phones, and a chart of operating systems that marks the ones out of support. Choosing a tile or slice lists the devices, and administrators choose how each layout counts under Settings → Asset statistics. (#106)
- **Tickets from the ConnectWise platform:** a Tickets card with tickets opened and closed per day and a tile per status, plus a Ticket details table on each client's overview. Tickets are read from the ConnectWise platform API with the existing connection and company links; turn on Tickets under *What to sync*. (#107)
- **Domain and SSL trackers:** domains are re-checked with their registry and certificates are read from each site on a schedule, and the dates are saved on the asset so Expirations and its alerts pick them up. A Domain and SSL expiry card shows what is expired or expiring, and each client has Domain Tracker and SSL Tracker tabs with Check now. (#108)
- **Automated password rotation:** Administration → Password rotation changes local administrator and Active Directory service account passwords on a schedule through ConnectWise RMM. The vault changes only after the device confirms the new password; failures keep the old one and alert administrators. (#109)
- **Customizable dashboard:** star clients, documents, and assets for a Favorites card, and show, hide, and reorder dashboard cards. Client quick notes sit at the top of every client page with history, compare, and restore; client tabs show counts and can be hidden; and the overview shows primary contact, phone, hours, and maintenance window. (#111)
- **Secure notes, files, and Send:** the vault holds secure notes as well as logins, encrypted files can be attached to any entry, and Send shares text or a file once through a link whose key never reaches the server. (#114)

### Fixed

- **Passwords:** changing only some details of a password (for example a bulk rotation change, or restricting it) no longer clears its website address. (#28)
- **Browser extension:** it now follows the vault policies: restricted logins stay hidden from administrators when restricted passwords are for listed people only, and read-only accounts can't fill passwords or open files on entries when reveals are blocked. (#110, #112, #114)

## [1.6.0] - 2026-09-29

### Added

- **Microsoft 365 sync:** document each client's tenant from one multi-tenant app registration (Directory.Read.All, admin consent per tenant). Users become contacts (with their licenses and admin roles), paid subscriptions become License assets with seats bought and assigned, custom domains become Domain assets, and a Microsoft 365 asset lists the tenant's domains, subscriptions, and administrators. Runs every six hours or on demand; cancelled subscriptions and removed domains are archived. Set up under Administration → Import & export. (#103)
- **Runnable checklists:** reusable checklists for all clients or one, run step by step for a client with who ticked each step and when, notes, an assignee, and a due date. New Checklists page and client tab; runs export to Markdown or print to PDF. (#101)
- **Relationship map:** a Map tab on each client showing how its assets, passwords, documents, contacts, and locations link together, with the same links as a list. (#100)
- **Manufacturer detection:** a blank Manufacturer is filled in from the model (OptiPlex → Dell, ThinkPad → Lenovo), operating system, device name, or MAC address whenever a device is saved or synced; entered values are never replaced. ConnectWise RMM firmware names are tidied ("Dell Inc." → Dell). A Fill in manufacturers button handles existing assets. (#104)

## [1.5.3] - 2026-09-29

### Fixed

- **People & access:** the Manage dialog now offers Confirm Microsoft account (and Unlink Microsoft) on your own row, so an owner with no other administrator can link their own Microsoft account. (#92)

## [1.5.2] - 2026-09-29

### Fixed

- **Sign in with Microsoft:** the page Atlas redirects to after returning from Microsoft no longer fails with "Cross-site requests are not allowed."; cross-site requests are still refused for API paths. (#90)

## [1.5.1] - 2026-09-29

### Fixed

- **Sign in with Microsoft:** returning from Microsoft no longer fails with "Cross-site requests are not allowed."; passkey sign-in now respects "Require Microsoft sign-in" for staff; and confirming a Microsoft link now shows the account's name, email and ID and approves exactly that account. (#87)

## [1.5.0] - 2026-09-29

### Added

- **Sign in with Microsoft Entra ID:** staff can sign in with their Microsoft 365 account (OpenID Connect with PKCE, state, and nonce; the sign-in token is checked in full). Accounts are never created by signing in: a Microsoft account must match an existing Atlas user, by account ID once linked, and the first match by email waits for an administrator to confirm it under People & access. An option trusts Microsoft's own multi-factor sign-in; another requires Microsoft sign-in for staff while the owner can always still use a password. Set up under Settings → Microsoft sign-in. (#85)

### Changed

- New and changed passwords are breach-checked within about ten minutes, not at the next daily run. (#83)
- A sign-in with a step still to finish (Atlas MFA, MFA setup, or a password change) can now be reloaded without an error.

## [1.4.0] - 2026-09-29

### Added

- **Password health:** a report of weak, reused, overdue, expired, old, and breached passwords across the clients you can open, with a score per client, filters, a CSV export, and a health tile on the dashboard. Breached passwords are found with Have I Been Pwned's k-anonymity check: only the first 5 characters of a scrambled fingerprint leave the server, and only a count is stored. New and changed passwords are checked within about ten minutes, older results are re-checked daily; an administrator can run them now or turn them off for servers without internet access. (#81)

## [1.3.2] - 2026-09-29

### Fixed

- **ConnectWise RMM sync:** a device no longer fails with "Choose a listed option for Type". Extra values go only into fields that can hold them (a choice list takes one of its options), and the named mapping wins over them. (#79)

## [1.3.1] - 2026-09-29

### Changed

- **ConnectWise RMM sync imports every field:** besides hostname, IP, MAC, and the other named fields, every other value ConnectWise sends about a device (IDs, types, agent details, tags, nested details) goes into a field on the asset, matching existing fields by label and adding the ones the layout lacks. (#77)

## [1.3.0] - 2026-09-26

### Added

- **Duplicates:** Administration → Duplicates lists assets, contacts, and locations with the same name in the same client, and clients with the same name. Choose the record to keep and merge the rest into it: blank fields are filled, values without a field get a new field, links, files, and Hudu/ConnectWise RMM IDs move over, and merged assets are archived so they can be restored. Merging clients moves everything in them. (#75)

## [1.2.0] - 2026-09-26

### Added

- **Choose what gets imported:** the Hudu import lets an administrator tick which kinds of data to bring in (clients, locations, assets, documents, passwords), which companies, and which asset layouts. The choices are saved for the next run. ConnectWise RMM sync can be limited to sites or devices, and scheduled syncs follow the choice; with devices off, no device is ever archived. (#72)
- **Erase all data (owner only):** Settings → Danger zone. Requesting it needs the owner's password, a fresh authenticator code, and the organization's name typed exactly. A 10-minute wait follows, during which every administrator is emailed and any of them can cancel. The owner then confirms again, and a full backup is taken before anything is erased (nothing is erased if the backup fails). People, settings, integrations, backups, and the security log are kept. (#73)

### Fixed

- Red (danger) buttons have readable text in dark mode. (#73)

## [1.1.11] - 2026-09-26

### Fixed

- **Imports after a restart:** an import or ConnectWise RMM sync cut off by a restart (for example installing an update) is marked stopped when Atlas starts again, so a new one can start straight away instead of being refused for five minutes. (#70)

## [1.1.10] - 2026-09-26

### Fixed

- **ConnectWise RMM sync:** the note about archived duplicate copies says "copies" instead of "copyies". (#68)

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
