# Deploying MSP Atlas

Atlas runs as one Node.js service in front of PostgreSQL 16, behind an HTTPS reverse proxy. The supported path today is **Docker on Linux**. A Windows Server service installer is planned for milestone M4 and will use the same build.

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
  3. Remove the old key and restart.

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
| `LOG_LEVEL` | `info` | Logs are JSON; cookies and CSRF tokens are removed from them |

In development, with no key configured, Atlas creates `data/atlas-master.key` on first run.

## Email

Atlas sends password reset links, expiry alerts, and a Monday digest. An administrator sets it up under **Settings → Email**; nothing is needed in the environment.

- **Microsoft 365:** choose the Microsoft 365 preset (`smtp.office365.com`, port 587, STARTTLS). Sign in as a licensed mailbox, or one with send-as rights for the From address. In the Microsoft 365 admin center, open that user → **Mail** → **Manage email apps** and turn on **Authenticated SMTP**. If the account uses MFA, use an app password. Microsoft plans to retire basic authentication for SMTP in Exchange Online; OAuth sign-in is planned for Atlas before then.
- **Other providers or an internal relay:** choose **Other SMTP server** and enter the host, port, and encryption (STARTTLS on 587, TLS on 465, or none for a trusted relay).
- The SMTP password is encrypted with the master key. **Send test** checks the saved settings and shows the server's error if it refuses.
- Alerts go to staff who can see the item and haven't turned them off on their account page. Each email goes out once per person per day (alerts) or week (digest), even with several Atlas servers.

## Bringing data in

After setup, import from Hudu or CSV files under **Import & export**, or move a 0.2 prototype database with `npm run migrate-legacy -w @atlas/server -- <atlas.sqlite>` (in Docker: `docker compose -f deploy/docker-compose.yml exec app npm run migrate-legacy -w @atlas/server -- /data/atlas.sqlite`, after copying the file into the data volume). See [Data in and out](DATA.md).

## Health, logs, and upgrades

- `GET /healthz` reports that the process is up. `GET /readyz` also checks the database. The container health check uses `/healthz`.
- Database migrations run automatically on start. A database lock ensures only one instance migrates at a time.
- **To upgrade:** pull or build the new image, then run `docker compose ... up -d`. Back up first (below).

## Backups (interim, until M4 adds scheduled encrypted backups)

```bash
docker compose -f deploy/docker-compose.yml exec -T db pg_dump -U atlas -Fc atlas > atlas-$(date +%F).dump
# restore into an empty database:
docker compose -f deploy/docker-compose.yml exec -T db pg_restore -U atlas -d atlas --clean --if-exists < atlas-YYYY-MM-DD.dump
```

Attachments are stored as files in the data volume, not in PostgreSQL, so back them up too:

```bash
docker run --rm -v atlas_data:/data -v "$PWD":/backup alpine tar czf /backup/atlas-files-$(date +%F).tgz -C /data attachments
```

Keep the database dump, the attachments archive, and a separate, protected copy of the master key together.
