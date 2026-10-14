---
title: When something isn't working
nav: Troubleshooting
out: support.html
active: support
group: Reference
order: 15
number: 15
summary: Symptoms and fixes, from sign-in problems to failed backups, syncs and rotations, and how to ask for help.
---

# When something isn't working

Most problems show up on **Admin → System status** first. Start there, then find the symptom below.

<p><label class="sr-only" for="filter">Filter troubleshooting</label><input id="filter" class="filter" type="search" placeholder="Type a symptom, setting or page" data-filter /></p>
<p class="filter-empty" data-filter-empty hidden>Nothing here matches that. Try the search at the top, which covers the whole manual.</p>

## Signing in

### I lost the setup code

With Docker: `docker compose -f deploy/docker-compose.yml logs app | grep "setup code"`. With the Linux installer: `journalctl -u msp-atlas`. On Windows: `C:\ProgramData\MSP Atlas\logs\MSPAtlas.out.log`. It only works until the first account exists.

### Someone is locked out after too many attempts

Wait 15 minutes, or an administrator can use **Reset sign-in** on their account.

### Someone lost their phone

An administrator uses **Reset sign-in** and ticks **Also reset two-step verification**. If the owner lost their phone and recovery codes, another owner or administrator can do it; if there's none, whoever runs the server must help.

### Sign in with Microsoft or SAML says to wait

The first sign-in waits for an administrator to confirm the link under **People & access → Manage**.

## Access

### A technician can't see a client

A client someone can't access looks exactly like a missing one. Check their access for that client, their groups and their role under **People & access**.

### A password shows but can't be revealed

Revealing needs **Edit + passwords** for the client, a place on the entry's list if it's restricted, and a reason if the client requires one.

## Email

### Email isn't sending

**Admin → Email & alerts → Send test** shows the mail server's error. Prefer **Microsoft 365 (app registration)**; for legacy SMTP, Authenticated SMTP must be on for the mailbox.

## Backups and the server

### Backups are failing, or on the same disk

Read the error on **System status**. Check the backup folder exists, Atlas can write to it, and the disk isn't full. Point `ATLAS_BACKUP_DIR` at a network share to clear the same-disk warning.

### A restore fails with a key error

A backup can only be read with the master key it was made with. After a rotation, list the old key after the new one and try again.

### Atlas says it can't read or write a file, or a service is stopped

**Admin → Services**: restart the service, or use **Repair**. If you can't reach Atlas at all, run `sudo systemctl restart msp-atlas` on the server.

### Browsers warn about the certificate

**Admin → Certificate**: download the authority, install it, and open Atlas at the address on the certificate.

### Verify now reports a break in the security log

Someone changed the database directly. Keep the server as it is, export the security log, and investigate. Restore from a backup if needed.

## Imports and syncs

### A Hudu import stopped partway

Run it again. It updates what it already brought in rather than duplicating it. Duplicates can be merged under **Admin → Duplicates**.

### ConnectWise devices or tickets are missing

Under **Import & export → ConnectWise RMM**, check the company is linked to a client, that devices and tickets are ticked, and read the last sync's messages. Tickets need the tickets read permission. Choose **Sync now** after a change.

### A warranty date is missing

Lookups cover Dell, Lenovo and HP devices with a serial number. Choose **Check warranty** on the asset, or type the date in.

### A domain or certificate shows as unknown

Choose **Check now** on the client's tracker tab. Some registries don't publish an expiry date, and a certificate can only be read from a site Atlas reaches on port 443. Enter the date on the asset for those.

### A password rotation failed

The old password is still in the vault. Read the reason under **Password rotation → Recent attempts**. Check the script ID, that the device is online, and that the API key has Automation read and create.

## Apps

### The browser extension won't sign in

Enter your Atlas address, then approve the browser in Atlas after checking the codes match. Its session ends after 7 days unused, 30 days in all, or when your password changes.

### Atlas for Windows won't connect

It refuses a certificate Windows doesn't trust. Install the certificate authority (above) and use the address on the certificate.

## Still stuck

Open an issue on [GitHub](https://github.com/ithealthtech/nexus-atlas/issues) for a verified defect. Never include passwords, master keys, API keys, client data, or screenshots with secrets in them. Report suspected vulnerabilities privately, as described in the [security model](security.html#reporting-a-vulnerability).
