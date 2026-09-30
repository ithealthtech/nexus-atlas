# Administrator guide

This guide is for the people who set up and run Atlas for an MSP. Installing the server is covered in [Deployment](DEPLOYMENT.md); this guide starts once Atlas is running.

## First day

1. **Create the owner account.** Open Atlas, enter the setup code from the server console (or `MSPAtlas.out.log` on Windows), and fill in your company and your own account. Set up two-step verification when asked. An authenticator app or a passkey both work.
2. **Save your recovery codes.** They're shown once. Keep them somewhere other than Atlas.
3. **Back up the master key.** It's what protects every password in Atlas and every backup file. See [the master key](DEPLOYMENT.md#the-master-key).
4. **Set up email** under **Settings → Email** (Microsoft 365 or any SMTP server) and choose **Send test**. Email is needed for password resets, expiry alerts, and the weekly digest.
5. **Check System status.** It lists anything that still needs attention, for example backups kept on the same disk as Atlas.
6. **Bring your data in** from Hudu or spreadsheets under **Import & export**. See [Data in and out](DATA.md).

## People and access

**People & access** lists everyone who can sign in.

- **Roles:**
  - **Owner** and **Admin** manage everything.
  - **Technicians** work on the clients they're given.
  - **Read-only technicians** can look but not change.
  - **Client editors** and **Client viewers** are your clients' own staff.
  - The full table is in [Identity and permissions](IDENTITY.md#roles).
- **Access levels per client:** *none*, *read*, *edit*, or *edit + passwords*. Staff can have an "every client" level, which also applies to clients added later. A per-client grant can raise it for one client.
- **Groups** (under **Groups**) give a team access to a set of clients in one place. Someone's access is the highest of their own level, their grants, and their groups' grants, but never more than their role allows.
- **Adding someone** creates a temporary password for them to change at first sign-in. Staff must set up two-step verification before they can do anything else.
- **When someone loses their phone,** use **Reset sign-in** and tick *Also reset two-step verification*. They set it up again at next sign-in.
- **When someone leaves,** edit them and tick *Disable this account*. Their sessions end at once, and their history stays.

Changes to access apply to people who are already signed in, straight away.

## Passwords

- **Who can open the vault:** only people with *edit + passwords* on a client can see its passwords.
- **Restricting an entry:** administrators can restrict an entry to named people or groups. Everyone else, including other administrators' technicians, can't see that it exists.
- **Reasons:** a client can require a reason before any password is revealed (edit the client and tick *Require a reason to view passwords*).
- **Access history:** every reveal, copy, change, and share is recorded on the password and in **Security log → Vault access**.
- **Sharing with the client:** ticking *Share with the client's own accounts* on an entry lets that client's own contacts see it, read-only.

## Automatic password rotation

**Administration → Password rotation** changes local administrator and Active Directory service account passwords on a schedule, through ConnectWise RMM, and keeps the new ones in the vault.

1. **Set up ConnectWise RMM.** Connect it under **Import & export** and sync the client's devices. Give its API key the **Automation read** and **Automation create** permissions as well.
2. **Add the script.** Import `deploy/rmm/Invoke-AtlasPasswordRotation.ps1` into ConnectWise RMM (**Automation → Scripts**) as a PowerShell script, and enter its ID on the Password rotation page. Tick **Rotate passwords automatically**.
3. **Add a policy** for each account type: how often (in days) and the password rules (length and kinds of character). A policy for **All clients** is the default; a client's own policy replaces it for that client. Without an active policy, nothing rotates.
4. **Choose the passwords.** Pick the client, the vault entry, and the device the script runs on. The entry's username is the account that's changed. For an AD service account, choose a domain controller (or a server with the ActiveDirectory PowerShell module).

**How a rotation works.** Atlas starts the script on the device with a token that works for that one rotation only, for two hours. The script generates a password to the policy and sends it to Atlas *before* changing anything; Atlas checks it against the policy and holds it encrypted. The script then sets the password and reports whether that worked. Only a confirmed change replaces the password in the vault; the old one moves to the entry's history.

**When a rotation fails,** the old password stays in the vault, and Atlas records the failure in the password's access history and the security log, and emails administrators (when email is set up). If a device reported a password but never confirmed setting it, that password is also kept in the entry's history, marked *unconfirmed*, in case the device did change the account. A failed account is tried again after a day.

**Revoking tokens.** Cancel one attempt from **Recent attempts**, or choose **Revoke device tokens** to stop every attempt in progress. Turning rotation off does the same.

## Keeping Atlas healthy

Check **System status** every week or so. It shows:

- **Backups:** the last good backup, the next scheduled one, and the history. **Back up now** makes one on demand, and **Download** saves a copy (you'll be asked for your password again). A red row means the last backup failed; the message says why.
- **Disk space** for the data and backup folders.
- **Email**, the **master key** in use, and whether an old key is still loaded after a rotation.
- **The security log check.** Open **Security log** and choose **Verify now**. Atlas checks that no event has been changed or removed since it was written.

## Security log and exports

- **Security log** records sign-ins, failures, lockouts, account and access changes, API key use, exports, and backups, with the address each came from.
- **Export** the security log and the vault access history as CSV from the same page. Exporting needs your password again.
- **Retention:** by default everything is kept forever. You can choose 1–7 years under **Settings → Alerts and logs**.

## Branding and the client portal

- **Settings → Branding** sets your logo, an accent colour, and a welcome message for client accounts.
- **Client accounts** sign in at the same address and see only their own clients. They see documentation you've given them, and only the passwords shared with them.

## API keys

**Settings → API keys** creates keys for PSA, RMM, and scripts.

- **Scopes:** each key gets `read`, `write`, and optionally `passwords`.
- **The key acts as you:** it acts with your access, is shown once, and expires after a year unless you choose otherwise.
- **Revoke keys** you no longer use.
- The API is documented at `/api/openapi.json`. See [Data in and out](DATA.md#rest-api).

## Browser extension

The extension for Edge and Chrome (Manifest V3) fills logins from the vault for staff. Client accounts can't use it.

- **Building it:** `npm run build:extension` writes the unpacked extension to `apps/extension/dist` and a zip to `apps/extension/package`. The extension's version follows Atlas's.
- **Installing it:** for a trial, open `edge://extensions` or `chrome://extensions`, turn on developer mode, and choose **Load unpacked** with the `dist` folder. For your team, publish the zip privately to the Edge Add-ons or Chrome Web Store dashboard, or host it and force-install it with the `ExtensionInstallForcelist` group policy.
- **Permissions:** it can only read and fill the tab you open it on (`activeTab`), and it asks to reach one address: your Atlas. It has no access to other sites and runs nothing on pages until you choose **Fill**.
- **What it stores:** the Atlas address, a session token, and a signing key the browser won't let it export. No passwords, codes, or lists of logins.
- **Sign-ins:** approvals and sign-ins appear in the security log as *Device sign-in approved* and *Signed in* (naming the browser). Each fill and copy is in the vault access history, and the person's name there includes the browser.
- **Taking it away:** **Sign out everywhere** on the Users page, disabling the account, or resetting its sign-in also signs out the extension.

## If something goes wrong

| Problem | What to do |
|---|---|
| Someone is locked out after too many attempts | Wait 15 minutes, or use **Reset sign-in** on their account. |
| The owner lost their phone and recovery codes | Another owner or admin can reset their sign-in. If there is none, contact whoever runs the server. |
| Backups are failing | Read the error on **System status**. Check that the backup folder exists and Atlas can write to it, and that the disk isn't full. |
| **Verify now** reports a break | Someone changed the database directly. Keep the server as it is, export the security log, and investigate. Restore from a backup if needed. |
| Restoring from a backup | Stop Atlas and follow [Restoring](DEPLOYMENT.md#restoring). You need the master key the backup was made with. |
