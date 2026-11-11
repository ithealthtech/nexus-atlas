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

Atlas runs as one Node.js service, with its data in PostgreSQL, behind something that serves HTTPS. There is no default administrator or password: you create the owner account yourself, with a one-time setup code the server prints. This chapter takes you from an empty server to a working Atlas, then through the first day.

## Before you start

Decide three things first. Each is hard to change later.

1. **Where it runs.** Pick one of the three ways below.

| Way | Best for | Updates |
|---|---|---|
| **Ubuntu or Debian installer** | Most MSPs. One command installs everything, and only this way can be updated, restarted, repaired and moved between remote access options from inside Atlas. | From **Admin → Updates**, with one click, or `sudo atlas-install`. |
| **Docker Compose** | Teams that already run containers. | Pull the new image and restart. |
| **Windows Server** | A Windows-only environment. | Extract the new package and run the script again. |

2. **The address people will use**, such as `https://atlas.example.com`, and how they'll reach it: from the internet directly, through Cloudflare Tunnel or Tailscale, or through your own reverse proxy. Read [Remote access and HTTPS](manual/remote-access.html) before installing. A public DNS name gives you a certificate every computer trusts; an IP address works, but every computer then has to install the server's certificate authority.
3. **Where backups and the master key will live**, off the server. See [The master key](#the-master-key).

**A server for it.** A virtual machine with 2 processor cores, 4 GB of memory and 40 GB of disk is a comfortable start; Atlas is built on the server during installs and updates, which needs the memory. Add disk for your attachments, and room for 14 backups of the whole database and attachments, unless backups go to another disk or share. The server needs to reach GitHub and the package repositories over HTTPS to install and update.

## Ubuntu or Debian

The installer works on Ubuntu 22.04 or 24.04, or Debian 12, on a fresh server or one with nothing else on ports 80 and 443. It installs Node.js 24 and PostgreSQL 16 from their own repositories, and Caddy as the web proxy, creates the database with a password it generates, downloads and builds Atlas, and runs it as the `msp-atlas` systemd service as an `atlas` system user. It also sets up the nightly backup and the helper that installs updates. It installs the newest published release, so these commands never need a version number.

1. Sign in to the server as a user who can use `sudo`.
2. If people will reach Atlas at a DNS name directly, create its DNS record pointing at the server, and open ports 80 and 443 to it first, so the certificate can be issued during the install. See [This server](manual/remote-access.html#this-server).
3. Download and run the installer, with your address:

```bash
curl -fsSL https://raw.githubusercontent.com/ithealthtech/nexus-atlas/main/deploy/linux/install-atlas.sh -o install-atlas.sh
sudo bash install-atlas.sh --public-url https://atlas.example.com
```

4. Wait. A first install takes about five to fifteen minutes, most of it building Atlas.
5. When it finishes, it prints **First-run setup code:** followed by the code. Copy it. It's also in `sudo journalctl -u msp-atlas | grep "setup code"`.
6. Open the address, and go on to [Creating the owner account](#creating-the-owner-account).

### Installer options

| Option | What it does |
|---|---|
| `--public-url URL` | The address people use. Must start with `https://`. On a later run, leave it out to keep the current one. With no address at all, the installer uses `https://` and the server's first IP address. |
| `--version VERSION` | `latest` (the default) is the newest published release; pre-releases are never picked automatically. Or a release tag such as `v2.4.1`. A branch name such as `main` is for testing only. |
| `--access MODE` | How people reach Atlas: `direct` (the default), `cloudflare`, `tailscale` or `proxy`. The same choices as **Admin → Remote access**. |
| `--tunnel-token-file FILE` | With `cloudflare`: a file holding the Cloudflare Tunnel's token. |
| `--tailscale-key-file FILE` | With `tailscale`: a file holding a Tailscale auth key, the first time. |
| `--funnel` | With `tailscale`: serve Atlas on the internet with Funnel. |
| `--trusted-proxy LIST` | With `proxy`: your reverse proxy's addresses or ranges, separated by commas. |
| `--repo URL` | Install from another Git repository. Only for your own fork. |
| `--help` | Lists every option. |

Running the installer again is safe: it keeps your settings, master key, database password, data and remote access choice. Run it with no options to update to the newest release, or to put back the service files and web proxy settings if they've been changed by hand. The installed copy is `sudo atlas-install`.

### Where things are

| Path | What's there |
|---|---|
| `/opt/msp-atlas` | The program. Read-only to Atlas. Replaced by every update. |
| `/etc/msp-atlas/atlas.env` | Atlas's settings, including the database password. Readable by root and Atlas only. |
| `/etc/msp-atlas/master.key` | The master key. Copy it somewhere safe now. |
| `/etc/msp-atlas/access.conf` | How Atlas is reached, as chosen on **Admin → Remote access**. |
| `/var/lib/msp-atlas` | Attachments, and backups in `backups/`. |
| `/var/lib/msp-atlas-updater` | The updater's status and logs. |
| `/etc/caddy/Caddyfile` | The web proxy's settings. Written by Atlas; changes by hand are replaced. |

To change a setting in `atlas.env` (see the [deployment guide](https://github.com/ithealthtech/nexus-atlas/blob/main/docs/DEPLOYMENT.md#configuration) for all of them), edit it as root and run `sudo systemctl restart msp-atlas`. Change the address and proxies on **Admin → Remote access** instead, so the web proxy changes with them.

## Docker (Linux)

The Compose file runs three containers: Atlas, PostgreSQL 16, and Caddy, which gets a public certificate for your DNS name.

1. Install Docker Engine with the Compose plugin.
2. Point a DNS name at the server, and open ports 80 and 443. Caddy uses them to get and renew the certificate.
3. Get the files: clone the repository, or download it from the [latest release](https://github.com/ithealthtech/nexus-atlas/releases/latest).
4. Copy `.env.example` to `.env` and set:
  - `PUBLIC_URL`: the address, such as `https://atlas.example.com`;
  - `ATLAS_DOMAIN`: the same name without `https://`, such as `atlas.example.com`. Caddy requests the certificate for it;
  - `POSTGRES_PASSWORD`: a long random value;
  - `ATLAS_MASTER_KEY`: a new master key, made with the command below. Copy it somewhere safe now.

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Without Node.js, `openssl rand -base64 32 | tr '+/' '-_' | tr -d '='` makes the same kind of key.

5. Start Atlas and read the setup code from the log:

```bash
docker compose -f deploy/docker-compose.yml --env-file .env up -d
docker compose -f deploy/docker-compose.yml logs app | grep "setup code"
```

6. Open the address, and go on to [Creating the owner account](#creating-the-owner-account).

A ready-built image is published for each release, `ghcr.io/ithealthtech/nexus-atlas:{{version}}`. The database is kept in the `db` volume, and attachments and backups in the `data` volume. Keep both, and `.env`, when you update.

## Windows Server

1. Install Node.js 24 LTS and PostgreSQL 16 or 17. In PostgreSQL, create an empty database and a user that owns it, for example with pgAdmin, or with `CREATE USER atlas WITH PASSWORD '…'; CREATE DATABASE atlas OWNER atlas;` in `psql`.
2. Download `msp-atlas-{{version}}-windows.zip` from the [latest release](https://github.com/ithealthtech/nexus-atlas/releases/latest). Check it with `Get-FileHash` against the `.sha256` file beside it; the two must match. Extract it to a folder such as `C:\Program Files\MSP Atlas`.
3. From an elevated PowerShell prompt in that folder, run:

```powershell
.\deploy\windows\Install-Atlas.ps1 -PublicUrl https://atlas.example.com -DatabaseUrl "postgres://atlas:<password>@localhost:5432/atlas"
```

The script:

- creates `C:\ProgramData\MSP Atlas`, readable only by Administrators and SYSTEM;
- creates the master key file there on first install, and never overwrites it. Copy it somewhere safe now;
- writes `atlas.env` there with your settings;
- downloads the WinSW service wrapper, checks it against a known SHA-256, and registers the **MSPAtlas** service, which starts automatically and restarts if it stops;
- starts it and waits until Atlas answers.

The setup code is in `C:\ProgramData\MSP Atlas\logs\MSPAtlas.out.log`.

| Option | What it does |
|---|---|
| `-PublicUrl` | The address people use. Needed the first time. |
| `-DatabaseUrl` | The PostgreSQL connection. Needed the first time. |
| `-BackupDir` | Where backups go, such as `\\nas\atlas-backups`. The computer's account needs write access to the share. |
| `-DataDir` | Where data, settings and the key live. Default `C:\ProgramData\MSP Atlas`. |
| `-Port` | The local port Atlas listens on. Default `4318`. |
| `-Uninstall` | Removes the service, but leaves data, key and backups in place. |

> [!note] HTTPS on Windows
> Atlas listens only on `127.0.0.1:4318`, so it can't be reached from other computers until something serves it over HTTPS: IIS with URL Rewrite and Application Request Routing, Caddy for Windows, `cloudflared` or Tailscale, pointed at `http://127.0.0.1:4318`. See [Remote access and HTTPS](manual/remote-access.html#docker-and-windows).

To upgrade, extract the new package over the old folder and run the script again with no arguments. It keeps your settings and key.

## Creating the owner account

The first account is the owner: the one account that can do everything, including change how Atlas is reached and erase all data.

1. Open Atlas at its address. It shows **Create the owner account**.
2. Enter the **Setup code**. It works only until the first account exists, and Atlas never shows it in the browser.
3. Enter the **Company name** (your MSP's name, shown throughout Atlas), **Your name**, your **Email** and a **Password** of at least 12 characters. A long passphrase is best.
4. Choose **Create owner account**.
5. Set up two-step sign-in when asked: scan the code with an authenticator app and enter the 6-digit code it shows. Staff accounts must use one.
6. Save the recovery codes Atlas shows somewhere other than Atlas, such as a sealed envelope or another password manager. They're how you get in if you lose your phone.

## The master key

The master key protects every encrypted value in Atlas: vault passwords, one-time code keys, MFA secrets, and the stored email, Hudu, ConnectWise, Microsoft and SIEM credentials. Backups are encrypted with a key made from it too.

> [!warning] Keep a copy of the master key offline
> If you lose the key, encrypted data and backups can't be recovered, by you or anyone else. Keep a copy in your existing password manager and a sealed printout, never next to database backups. Someone with a backup but no key can't read it; someone with both can.

Where it is: `/etc/msp-atlas/master.key` on Linux, `C:\ProgramData\MSP Atlas` on Windows, or `ATLAS_MASTER_KEY` in Docker's `.env`.

### Rotating the master key

Rotate it if a copy may have been exposed, or as your policy requires.

1. Take a backup on **System status**.
2. Make a new key (as for Docker above). Put it first, and keep the old one after it: one per line in the key file, or separated by a comma in `ATLAS_MASTER_KEY`.
3. Restart Atlas. It now encrypts with the new key and can still read the old.
4. Re-encrypt everything with the new key. On Linux: `cd /opt/msp-atlas && sudo runuser -u atlas -- node --env-file=/etc/msp-atlas/atlas.env apps/server/dist/cli/rewrap-keys.js`. In Docker: `docker compose -f deploy/docker-compose.yml exec app npm run rewrap-keys -w @atlas/server`. It prints how many values it changed.
5. Remove the old key and restart. Keep a copy of the old key for as long as you keep backups made with it. System status warns while an old key is still loaded.

## Your first day

**Admin → Set up Atlas** keeps track of these steps for you. Each one ticks itself off when it's really done (an email server saved, a client added, a backup taken), however you did it, and links straight to where it's done. Until the essential steps are finished, your dashboard shows a **Set up Atlas** card with the next ones.

1. **Turn on two-step sign-in for yourself,** if you skipped it.
2. **Back up the master key**, as above.
3. **Make it yours** under **Admin → Theme**. See [Settings](manual/settings.html#theme).
4. **Connect email** under **Admin → Email & alerts**, and choose **Send test**. Email is needed for password resets, expiry alerts and the weekly digest. See [Settings](manual/settings.html#email-and-alerts).
5. **Bring your documentation across** from Hudu or spreadsheets under **Admin → Import & export**, or **add your first client**. See [Data and integrations](manual/integrations.html).
6. **Connect ConnectWise RMM** and **Microsoft 365**, if you use them.
7. **Invite your team** and set their client access under **Admin → People & access**. See [People and access](manual/people-and-access.html).
8. **Take a first backup** on **Admin → System status**, and check every check there is green.

## Where to go next

- [Remote access and HTTPS](manual/remote-access.html) to change how people reach Atlas, and for its certificate.
- [People and access](manual/people-and-access.html) for roles, groups and single sign-on.
- [Keeping Atlas healthy](manual/looking-after-atlas.html) for backups, updates and services.
- The [deployment guide](https://github.com/ithealthtech/nexus-atlas/blob/main/docs/DEPLOYMENT.md) lists every setting.
