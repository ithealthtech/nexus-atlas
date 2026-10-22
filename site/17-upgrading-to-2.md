---
title: Upgrading to Atlas 2.0
nav: Upgrading to 2.0
out: manual/upgrading-to-2.html
group: Running Atlas
order: 17
number: 17
summary: What changes in 2.0, the few things to do after upgrading, and how to go back if you need to.
---

# Upgrading to Atlas 2.0

Atlas 2.0 is the biggest update yet, but upgrading works like any other release: your data, settings, master key and everyone's preferences carry over. This page covers what's new, the few things worth doing afterwards, and how to go back.

## Before you upgrade

1. **Check that last night's backup finished.** It's under **Administration → System status**. If backups sit on the same disk as Atlas, copy the newest one somewhere else.
2. **Make sure you can lay your hands on the master key** (`/etc/msp-atlas/master.key` on Linux, or wherever you keep your copy). A backup can't be restored without it.
3. **Pick a quiet time.** Atlas restarts while it updates, and is usually back within a few minutes.

## Upgrade

- **Installed with the Linux installer:** go to **Administration → Updates** and choose **Install** on 2.0. Atlas asks for your password and takes a backup before anything changes. It then installs the release and restarts. If the install fails, it puts the previous version back on its own. From a terminal, `sudo atlas-install --version v2.0.0` does the same.
- **Docker:** pull the 2.0 image and run `docker compose ... up -d`, after a backup.
- **Windows Server:** run the 2.0 package's `Install-Atlas.ps1`, after a backup.

Atlas updates its database the first time 2.0 starts. Nothing needs doing by hand.

## What's new

Everyone sees a **Welcome to Atlas 2.0** card on their dashboard. It leads to the What's new page, which is always under **What's new** in the account menu. In short:

- **Reports:**
  - a client review pack;
  - reports that email themselves on a schedule, and alerts that only send when something new needs attention;
  - a cyber insurance readiness report;
  - a savings finder;
  - Microsoft 365 accounts and usage;
  - every report readable on one page.
- **A health score for every client.**
- **Faster documenting:** smart paste for assets, Wi-Fi join codes, and the Licenses page showing everything at once.
- **A cleaner workspace.** Your menu style (rail and panel, sidebar, or top bar) carries over.
- **Atlas for Windows 1.0.**

## What's gone

- **The Monthly report button** on a client's page. The client's **Reports** tab replaces it, with PDFs, share links and schedules, and old links to the monthly report open that tab.
- **The 0.2 importer.** If you still have an Atlas 0.2 database, move it with Atlas 1.8 before upgrading.
- **Scripts:** the supported API is `/api/v1`. API keys only ever worked there, so nothing you've set up changes.

## After you upgrade

These take a few minutes, and only the ones that apply to you matter.

### Everyone

- **Look at the dashboard's Set up Atlas card** (administrators). It lists anything an installation should have and doesn't yet, such as email or a recent backup.

### If you use Microsoft 365 with GDAP

The new **Microsoft 365 usage** report reads Microsoft's usage reports, which need a permission Atlas didn't ask for before.

1. In your partner app registration, add the Microsoft Graph delegated permission **Reports.Read.All** and grant consent.
2. Give your GDAP security group a role that can read usage reports, such as **Reports Reader**.
3. In Atlas, under **Administration → Import & export → Microsoft 365**, choose **Reconnect partner account**.

Everything else carries on as before. Until you do this, the usage report says what's missing rather than failing quietly. See [Data and integrations](integrations.html).

### If you send reports or alerts by email

Scheduled reports and alerts are sent through the email server under **Administration → Email & alerts**. Choose **Send test** there to make sure it works.

### If your favicon is an SVG

Atlas for Windows uses your favicon as its icon, and Windows can't draw an SVG. Open **Administration → Theme** and choose **Save** once: Atlas makes a picture Windows can use.

### Atlas for Windows

Technicians' copies offer **Install and restart** for version 1.0 on their own, within six hours, or straight away from **Check for updates**. New installs download it from **Your account → Desktop apps**.

- One download works on every PC, including Arm laptops.
- If your organization hasn't set up code signing, Windows SmartScreen still asks before the setup program runs: choose **More info**, then **Run anyway**.

## Going back to 1.x

If something important doesn't work, you can return to the version you had. The backup taken before the upgrade holds everything as it was.

On Linux (installed with the installer):

1. Install the previous release, for example `sudo atlas-install --version v1.8.4`.
2. Stop Atlas: `sudo systemctl stop msp-atlas`.
3. Restore the backup taken just before the upgrade. It's the newest file in the backups folder (`/var/lib/msp-atlas/backups` unless you changed `ATLAS_BACKUP_DIR`) from before you upgraded:

   ```bash
   cd /opt/msp-atlas
   sudo runuser -u atlas -- node --env-file=/etc/msp-atlas/atlas.env apps/server/dist/cli/restore.js /var/lib/msp-atlas/backups/<file>.atlasbak --replace
   ```

4. Start Atlas: `sudo systemctl start msp-atlas`. Everyone signs in again.

Anything changed in Atlas after the upgrade is lost by going back, because the backup is from before it. For Docker and Windows, go back to the previous image or package, then restore the same way (see [Keeping Atlas healthy](looking-after-atlas.html#restore-a-backup)).

If you go back, please say what didn't work through the support channel or GitHub, so it can be fixed in 2.0.1.
