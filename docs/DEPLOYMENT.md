# Deploying MSP Atlas

Atlas runs as one Node.js service in front of PostgreSQL 16, behind an HTTPS reverse proxy. It runs on **Docker (Linux)** or as a **Windows service**; both use the same build.

## Docker Compose (Linux)

1. Point a DNS name (for example `atlas.yourmsp.com`) at the server, and open ports 80 and 443. Caddy uses them to get and renew the certificate automatically.
2. Copy `.env.example` to `.env` and fill it in:
   - `PUBLIC_URL`: `https://atlas.yourmsp.com`. Atlas refuses to start in production without https.
   - `ATLAS_DOMAIN`: `atlas.yourmsp.com`.
   - `POSTGRES_PASSWORD`: a long random value.
   - `ATLAS_MASTER_KEY`: generate one with `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"` (or `openssl rand -base64 32 | tr '+/' '-_' | tr -d '='`).
3. Start it:
   ```bash
   docker compose -f deploy/docker-compose.yml --env-file .env up -d
   docker compose -f deploy/docker-compose.yml logs app | grep "setup code"
   ```
4. Open `PUBLIC_URL`, enter the setup code, and create the owner account. The setup code works only until the first account exists. You can also set `ATLAS_SETUP_CODE` yourself, in which case Atlas doesn't print it.

**Behind a proxy that inspects TLS:** if image builds can't reach npm because of a corporate TLS-inspecting proxy, pass its CA certificate at build time:
`docker build --secret id=ca_cert,src=proxy-ca.pem .`
The certificate is used only for the install step and is not stored in the image.

## The master key

- **What it protects:** secrets that are stored encrypted, namely MFA secrets now and vault passwords from M2. Everything else is in PostgreSQL.
- **Keep a copy offline**, separate from database backups: for example, in your existing password manager plus a sealed printout. **If you lose the key, encrypted data can't be recovered.** If someone steals a database backup without the key, they can't read those secrets.
- **What the vault stores:** each organization's vault data key is kept only in encrypted form, under the master key, in `vault_keys`. Passwords, notes, and TOTP keys are encrypted with that data key.
- **Rotating the master key:**
  1. Put the new key first and keep the old one after it (comma-separated in `ATLAS_MASTER_KEY`, or one per line in the key file). Restart.
  2. Run `docker compose -f deploy/docker-compose.yml exec app npm run rewrap-keys -w @atlas/server`. This re-encrypts the vault data keys and MFA secrets under the new key and prints how many it changed.
  3. Remove the old key and restart. Keep a copy of it for as long as you keep backups made before the rotation: those backups are encrypted with it.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | — (required) | PostgreSQL connection string |
| `PUBLIC_URL` | `http://127.0.0.1:4318` | Public address. Drives Host/Origin checks, `Secure` cookies, and HSTS. |
| `ATLAS_MASTER_KEY` / `ATLAS_MASTER_KEY_FILE` | — (required in production) | 32-byte base64url key(s) |
| `TRUST_PROXY` | `false` | Set to `true` behind Caddy, IIS, or nginx so client IP addresses are correct |
| `HOST`, `PORT` | `127.0.0.1`, `4318` | Listen address (the container uses `0.0.0.0`) |
| `ATLAS_SETUP_CODE` | random | Fixed first-run code, for automated installs |
| `ATLAS_REQUIRE_STAFF_MFA` | `true` | Require an authenticator app for staff |
| `ATLAS_MAX_UPLOAD_MB` | `25` | Largest attachment accepted |
| `ATLAS_DATA_DIR` | `./data` (`/data` in the container) | Holds attachments (`attachments/`) and, in development, the key file |
| `ATLAS_DIGEST_HOUR` | `7` | Local hour after which expiry alerts and the Monday digest are emailed |
| `ATLAS_BACKUP_ENABLED` | `true` | Nightly encrypted backups |
| `ATLAS_BACKUP_DIR` | `<data dir>/backups` | Where backups are written; ideally another disk or a share |
| `ATLAS_BACKUP_HOUR` | `2` | Local hour after which the nightly backup runs |
| `ATLAS_BACKUP_KEEP` | `14` | How many backup files to keep |
| `LOG_LEVEL` | `info` | Logs are JSON; cookies and CSRF tokens are removed from them |

In development, with no key configured, Atlas creates `data/atlas-master.key` on first run.

## Email

Atlas sends password reset links, expiry alerts, and a Monday digest. An administrator sets it up under **Settings → Email**; nothing is needed in the environment.

- **Microsoft 365 (app registration), recommended:** Atlas signs in as an Entra app with OAuth2 (client credentials) and sends through Microsoft Graph, with no mailbox password and no SMTP sign-in.
  1. In the Microsoft Entra admin center, go to **App registrations → New registration**. Choose single tenant and leave the redirect URI empty.
  2. Under **API permissions**, add **Microsoft Graph → Application permissions → Mail.Send**, then select **Grant admin consent**.
  3. Under **Certificates & secrets**, create a client secret. Note when it expires, and paste a new one into Atlas before then.
  4. In Atlas, choose **Microsoft 365 (app registration)**. Enter the Directory (tenant) ID, the Application (client) ID, the secret's *value*, and the From address. The From address must be a mailbox in that tenant; Atlas sends as that mailbox.
  5. Recommended: Mail.Send on its own lets the app send as *any* mailbox. Limit it to the From mailbox with an Exchange Online [application access policy](https://learn.microsoft.com/graph/auth-limit-mailbox-access) or RBAC for Applications.
- **Microsoft 365 SMTP (legacy):** `smtp.office365.com`, port 587, STARTTLS, signed in as a mailbox that has **Authenticated SMTP** turned on. Microsoft is retiring basic authentication for SMTP in Exchange Online, so **System status** warns while this is in use. Switch to the app registration.
- **Other providers or an internal relay:** choose **Other SMTP server** and enter the host, port, and encryption (STARTTLS on 587, TLS on 465, or none for a trusted relay).
- The SMTP password and the client secret are encrypted with the master key. **Send test** checks the saved settings and shows the server's or Microsoft's error if the message is refused.
- Alerts go to staff who can see the item and haven't turned them off on their account page. Each email goes out once per person per day (alerts) or week (digest), even with several Atlas servers.

## Bringing data in

After setup, import from Hudu or CSV files under **Import & export**, or move a 0.2 prototype database with `npm run migrate-legacy -w @atlas/server -- <atlas.sqlite>` (in Docker: `docker compose -f deploy/docker-compose.yml exec app npm run migrate-legacy -w @atlas/server -- /data/atlas.sqlite`, after copying the file into the data volume). See [Data in and out](DATA.md).

## Health, logs, and upgrades

- `GET /healthz` reports that the process is up. `GET /readyz` also checks the database. The container health check uses `/healthz`.
- Database migrations run automatically on start. A database lock ensures only one instance migrates at a time.
- **To upgrade:** pull or build the new image, then run `docker compose ... up -d`. Back up first (below).

## Backups

Atlas backs itself up every night. Each backup is one encrypted `.atlasbak` file holding the whole database and every attachment.

- **Schedule:** daily after `ATLAS_BACKUP_HOUR` (default 02:00 server time). The newest `ATLAS_BACKUP_KEEP` files are kept (default 14). **System status → Back up now** makes one on demand, and `npm run backup -w @atlas/server` does the same from the command line.
- **Where:** `ATLAS_BACKUP_DIR` (default `<data dir>/backups`). The status page warns while backups sit on the same disk as Atlas. Point this at a network share, or copy the folder off the server on a schedule.
- **Encryption:** AES-256-GCM with a key derived from the master key. A backup can't be read, and a changed or cut-off file is detected, without that key. **Keep the master key somewhere other than the backups.**
- **Checking a file:** `npm run backup -w @atlas/server -- verify <file>` reads the whole file and reports what's in it.
- **Not included:** sign-in sessions (everyone signs in again after a restore).

### Restoring

1. Stop Atlas.
2. Make sure the master key the backup was made with is loaded (`ATLAS_MASTER_KEY` or the key file). After a rotation, keep the old key listed.
3. Run `npm run restore -w @atlas/server -- <file.atlasbak>` against a new, empty database. To overwrite the current database and attachments, add `--replace`.
4. Start Atlas.

In Docker: `docker compose -f deploy/docker-compose.yml run --rm app npm run restore -w @atlas/server -- /data/backups/<file>`.

- **Nothing changes until the file checks out:** the restore reads the whole file first, and a damaged file stops it.
- **Older backups:** a backup from an older Atlas version is loaded at its own schema version, then upgraded.
- **Security log:** the hash chain and signed checkpoint are kept, so **Verify now** passes after a restore.

## Ubuntu without Docker

`deploy/linux/install-atlas.sh` installs everything on Ubuntu 22.04 or 24.04: Node.js 22 (NodeSource), PostgreSQL 16 (PGDG), and Caddy. It then builds Atlas from a release tag and runs it as a systemd service.

```bash
sudo ./deploy/linux/install-atlas.sh --public-url https://atlas.example.com
```

- **HTTPS:** Caddy gets a certificate for a DNS name automatically. For an IP address or a single-label name it uses a self-signed certificate (`tls internal`).
- **Where things go:** code in `/opt/msp-atlas` (read-only to the service), data and backups in `/var/lib/msp-atlas`, settings (`atlas.env`) and the master key in `/etc/msp-atlas`. The database password is generated on the server and kept only in `atlas.env`.
- **Service:** `msp-atlas` runs as the `atlas` system user on `127.0.0.1:4318`. The script prints the setup code; it's also in `journalctl -u msp-atlas`.
- **Upgrading:** `sudo ./deploy/linux/install-atlas.sh --version v1.0.2`. Settings, key, and database are kept.
- If the install-media (`cdrom`) apt source is still active, the script comments it out, since it breaks `apt-get update`.

## Windows Server

1. Install [Node.js 22 LTS](https://nodejs.org) and PostgreSQL 16, and create an empty database and user for Atlas.
2. Extract the Windows package from the GitHub release (`msp-atlas-<version>-windows.zip`, already built, with a `.sha256` checksum beside it) to, for example, `C:\Program Files\MSP Atlas`. From source instead: copy the repository there and run `npm ci` and `npm run build`.
3. From an elevated PowerShell prompt:
   ```powershell
   .\deploy\windows\Install-Atlas.ps1 -PublicUrl https://atlas.example.com -DatabaseUrl "postgres://atlas:<password>@localhost:5432/atlas"
   ```

What the script does:
- **Data folder:** creates `C:\ProgramData\MSP Atlas`, readable only by Administrators and SYSTEM.
- **Master key:** creates the key file there on first install, and reminds you to copy it somewhere safe.
- **Settings:** writes `atlas.env` with your settings.
- **Service wrapper:** downloads WinSW 2.12.0 and checks it against a pinned SHA-256.
- **Service:** registers the `MSPAtlas` service to start automatically and restart if it stops, then waits until Atlas answers.

After install:
- **Setup code:** the first-run setup code is in `C:\ProgramData\MSP Atlas\logs\MSPAtlas.out.log`.
- **HTTPS:** Atlas listens on `127.0.0.1:4318`. Publish it over HTTPS with IIS (URL Rewrite + Application Request Routing) or Caddy for Windows. Atlas trusts the proxy's forwarded client address.
- **Upgrading:** extract the new package over the old folder (or update the source and rebuild), then run the script again with no arguments. It keeps your settings and key.
- **Backups:** add `-BackupDir \\nas\atlas-backups` to keep them on another machine. The service account needs write access there.
- **Removing:** `-Uninstall` removes the service but leaves data, key, and backups in place.
