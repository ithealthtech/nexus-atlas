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
- **Rotation:** you can list several keys, comma-separated in `ATLAS_MASTER_KEY` or one per line in `ATLAS_MASTER_KEY_FILE`. Atlas encrypts new data with the first key and decrypts with whichever key matches. Tooling to re-encrypt existing data under the new key arrives with the vault (M2).

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
| `LOG_LEVEL` | `info` | Logs are JSON; cookies and CSRF tokens are removed from them |

In development, with no key configured, Atlas creates `data/atlas-master.key` on first run.

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

Keep backups together with a separate, protected copy of the master key.
