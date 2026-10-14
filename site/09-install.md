---
title: Installing Atlas
nav: Installing Atlas
out: install.html
active: install
group: Running Atlas
order: 9
number: 9
summary: Install Atlas on Ubuntu or Debian, with Docker, or on Windows Server, then create the owner account and get through the first day.
---

# Installing Atlas

Atlas runs as one Node.js service in front of PostgreSQL 16, behind HTTPS. There is no default administrator: you create the owner account with a one-time setup code. Pick the way that suits your server.

| Way | Best for | Updates |
|---|---|---|
| **Ubuntu or Debian installer** | Most MSPs. One command installs everything. | From the **Updates** page in Atlas, with one click. |
| **Docker Compose** | Teams that already run containers. | Pull the new image and restart. |
| **Windows Server** | A Windows-only environment. | Extract the new package and run the script again. |

## Ubuntu or Debian

The installer sets up Node.js 22, PostgreSQL 16 and Caddy on Ubuntu 22.04 or 24.04, or Debian 12, builds Atlas, and runs it as a systemd service. It installs the newest published release, so these commands never need a version number.

```bash
curl -fsSL https://raw.githubusercontent.com/ithealthtech/nexus-atlas/main/deploy/linux/install-atlas.sh -o install-atlas.sh
sudo bash install-atlas.sh --public-url https://atlas.example.com
```

The script prints the setup code when it finishes. It is also in `journalctl -u msp-atlas`.

- **Choosing a version:** `--version v1.0.2` installs that release. `sudo bash install-atlas.sh --help` lists every option.
- **HTTPS:** for a public DNS name, Caddy gets and renews a certificate by itself. For an IP address or a one-word name, it acts as its own certificate authority, which browsers don't trust until you install it. **Admin → Certificate** gives you the file. See [The certificate](manual/looking-after-atlas.html#the-certificate).
- **Where things go:** the program in `/opt/msp-atlas`, data and backups in `/var/lib/msp-atlas`, settings (`atlas.env`) and the master key in `/etc/msp-atlas`.
- **Upgrading:** from **Admin → Updates** in Atlas, or run `sudo atlas-install` on the server. Settings, key and database are kept.

## Docker (Linux)

1. Point a DNS name at the server, and open ports 80 and 443. Caddy uses them to get and renew the certificate.
2. Copy `.env.example` to `.env` and set `PUBLIC_URL`, `ATLAS_DOMAIN`, `POSTGRES_PASSWORD` and `ATLAS_MASTER_KEY`. Generate the key with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

3. Start Atlas and read the setup code from the log:

```bash
docker compose -f deploy/docker-compose.yml --env-file .env up -d
docker compose -f deploy/docker-compose.yml logs app | grep "setup code"
```

A ready-built image is published for each release: `ghcr.io/ithealthtech/nexus-atlas:{{version}}`.

## Windows Server

1. Install Node.js 22 LTS and PostgreSQL 16, and create an empty database and user for Atlas.
2. Download `msp-atlas-{{version}}-windows.zip` from the [latest release](https://github.com/ithealthtech/nexus-atlas/releases/latest), check it against the `.sha256` file beside it, and extract it to a folder such as `C:\Program Files\MSP Atlas`.
3. From an elevated PowerShell prompt, run:

```powershell
.\deploy\windows\Install-Atlas.ps1 -PublicUrl https://atlas.example.com -DatabaseUrl "postgres://atlas:<password>@localhost:5432/atlas"
```

The script creates `C:\ProgramData\MSP Atlas` (readable only by Administrators and SYSTEM), creates the master key file on first install, and registers the `MSPAtlas` service to start automatically. The setup code is in `C:\ProgramData\MSP Atlas\logs\MSPAtlas.out.log`.

> [!note] HTTPS on Windows
> Atlas listens on `127.0.0.1:4318`. Publish it over HTTPS with IIS (URL Rewrite and Application Request Routing) or Caddy for Windows. Add `-BackupDir \\nas\atlas-backups` to keep backups on another machine.

To upgrade, extract the new package over the old folder and run the script again with no arguments. It keeps your settings and key.

## The master key

The master key protects every encrypted value: vault passwords, one-time code keys, MFA secrets, and the email, Hudu, ConnectWise and SIEM credentials. It also encrypts backups.

> [!warning] Keep a copy of the master key offline
> If you lose the key, encrypted data and backups can't be recovered. Keep a copy in your existing password manager and a sealed printout, never next to database backups.

To rotate it, list the new key first and the old one after it, restart, run `npm run rewrap-keys -w @atlas/server`, then remove the old key. Keep the old key for as long as you keep backups made with it.

## Your first day

1. **Create the owner account.** Open Atlas, enter the setup code, and fill in your company and your own account.
2. **Turn on two-step verification** when asked, and save the recovery codes somewhere other than Atlas.
3. **Back up the master key** as described above.
4. **Set up email** under **Admin → Email & alerts**, and choose **Send test**. Email is needed for password resets, expiry alerts and the weekly digest.
5. **Bring your data in** from Hudu or spreadsheets under **Admin → Import & export**, or connect ConnectWise RMM. See [Data and integrations](manual/integrations.html).
6. **Invite your team** and set their client access under **Admin → People & access**. See [People and access](manual/people-and-access.html).
7. **Check System status** and make sure every check is green.

## Where to go next

- [People and access](manual/people-and-access.html) for roles, groups and single sign-on.
- [Keeping Atlas healthy](manual/looking-after-atlas.html) for backups, updates, services and the certificate.
- The [deployment guide](https://github.com/ithealthtech/nexus-atlas/blob/main/docs/DEPLOYMENT.md) lists every setting.
