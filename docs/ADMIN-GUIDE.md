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

## If something goes wrong

| Problem | What to do |
|---|---|
| Someone is locked out after too many attempts | Wait 15 minutes, or use **Reset sign-in** on their account. |
| The owner lost their phone and recovery codes | Another owner or admin can reset their sign-in. If there is none, contact whoever runs the server. |
| Backups are failing | Read the error on **System status**. Check that the backup folder exists and Atlas can write to it, and that the disk isn't full. |
| **Verify now** reports a break | Someone changed the database directly. Keep the server as it is, export the security log, and investigate. Restore from a backup if needed. |
| Restoring from a backup | Stop Atlas and follow [Restoring](DEPLOYMENT.md#restoring). You need the master key the backup was made with. |
