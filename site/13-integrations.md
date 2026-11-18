---
title: Data and integrations
nav: Data and integrations
out: manual/integrations.html
group: Running Atlas
order: 13
number: 13
summary: Importing from Hudu and spreadsheets, ConnectWise RMM, Microsoft 365 and Bitdefender syncs, the BitLocker collector, and automatic password rotation.
---

# Data and integrations

Microsoft Teams is under **Administration → Microsoft Teams**. Imports and syncs are under **Admin → Import & export**; the BitLocker collector and password rotation are in the Vault area.

![Import & export](../images/manual/import-export.png "Admin → Import & export.")

## Microsoft Teams

**Administration → Microsoft Teams** links each client to its own Teams channel. Staff can then read and post in that channel from the client's **More → Teams** page, and Atlas posts alerts there. Atlas signs in to Teams as one Microsoft work account you connect; no Azure Bot, Teams app or extra hosting is needed. Posts appear under that account's name, and Atlas's security log records which staff member wrote them.

### Before you start

You need a Microsoft Entra account that can register apps and grant admin consent, and a Teams-licensed work account that is a member of every channel Atlas will post in. A dedicated account, such as `atlas-alerts@yourmsp.com`, keeps alerts from looking like a person wrote them, but may need its own licence.

### Setting it up

1. In the Microsoft Entra admin center, open **App registrations → New registration**. Choose **Accounts in this organizational directory only**. Under **Redirect URI**, choose **Web** and enter your Atlas address followed by `/api/integrations/teams/callback`, such as `https://atlas.example.com/api/integrations/teams/callback`. Choose **Register**.
2. Copy the **Directory (tenant) ID** and **Application (client) ID**.
3. Under **Certificates & secrets**, create a client secret and copy its **Value**. Note when it expires.
4. Under **API permissions → Add a permission → Microsoft Graph → Delegated permissions**, add `ChannelMessage.Read.All`, `ChannelMessage.Send` and `ChannelMessage.ReadWrite`, plus `openid`, `profile`, `email` and `offline_access`. Choose **Grant admin consent**.
5. In Atlas, tick **Enable Microsoft Teams**, enter the **Directory (tenant) ID**, **Application (client) ID** and **Application secret**, and save.
6. Choose **Connect Microsoft account**, and sign in as the work account from **Before you start**.
7. Map each client to its channel. In Teams, choose **Get link to channel** on the channel; the link contains the team ID (`groupId=…`) and the channel ID (`19:…@thread.tacv2`, URL-encoded; decode `%3a` to `:` and `%40` to `@`). In Atlas, choose the **Client**, and enter the **Team ID**, a **Channel name** people will recognize, and the **Channel ID**.
8. Optionally, enter a **Security channel ID (optional)**: a channel in the same team that gets breach and infection alerts instead, such as one only your security team can see. It must not be a client's discussion channel.
9. Choose **Send test notification**. A test message marked as a test should appear in the channel.

### Automatic alerts

Under **Automatic alerts**, tick which alerts go to Teams: **Expirations**, **Document reviews**, **Password breaches** and **Confirmed infections**.

| Setting | What it does |
|---|---|
| **Reminder days** | Days before an expiry or review date when the client's channel is told. The default is 30, 14, 7, 1 and 0; 0 includes anything overdue. |
| **Daily digest hour (0–23)** | Expirations and reviews reaching a reminder day are grouped into one post a day, after this hour. Quiet days send nothing. |
| **Time zone** | The time zone for that hour, such as `America/New_York`. Daylight saving time is followed. |

Breaches and infections are checked every minute and posted straight away. A resolved infection is posted as a reply in the original thread. Posts never include a password, username, notes or recovery key: only a summary and a link that needs signing in to Atlas.

Once the [alerting center](https://github.com/ithealthtech/nexus-atlas/blob/main/docs/ALERTING.md) is live, its rules send Teams alerts instead, so they aren't sent twice.

### When something goes wrong

**Delivery history** lists every post with its client, alert, status and details. If Microsoft throttles Atlas, it waits and tries again, up to five times. If Microsoft asks the account to sign in again, alerts wait in the queue: choose **Connect Microsoft account** again, and they go out. A post whose outcome Atlas couldn't confirm is held for you to check in Teams rather than sent twice. When the secret expires, create a new one, paste it into **Application secret** and save. The [Teams guide](https://github.com/ithealthtech/nexus-atlas/blob/main/docs/TEAMS.md) covers the infection-event feed and the details.

## Import from Hudu

1. In Hudu, go to **Admin → API Keys** and create a key. A key without password access imports everything except passwords.
2. In Atlas, open **Import & export → Hudu**, enter the Hudu address (https only) and the key, and choose **Connect**. The key is encrypted with the master key.
3. Choose what to bring in: kinds of data, companies, and asset layouts. The choices are saved for next time.
4. **Preview** counts what Hudu has. **Start import** runs it in the background, with progress and a summary per type.

| Hudu | Atlas |
|---|---|
| Companies | Clients. A company is matched to an existing client with the same name. |
| Asset layouts and assets | Layouts and assets under the matching client. |
| Knowledge base articles | Documents for the client, or the MSP knowledge base. |
| Passwords | The client's vault, including one-time code keys. |
| Processes | Checklists. |
| Networks | Networks assets. |
| Relations | Links between the imported items. |

**Running it again is safe.** Atlas remembers which Hudu item became which record and updates it rather than creating a duplicate. Archived Hudu items are skipped.

## Import a spreadsheet (CSV)

**Import & export → CSV** brings in clients, contacts, locations, assets (into a chosen layout) or passwords.

1. Choose the kind of data and the file (comma, semicolon or tab separated, up to 10 MB, with a header row).
2. Check the column matching. Atlas matches columns by name, including common alternatives such as "Company", and any column can be reassigned.
3. Choose **Check the file first**. It reports every problem with its row number and saves nothing.
4. Choose **Import**.

Importing passwords needs **Edit + passwords** on each client involved, and is recorded in the security log.

## ConnectWise RMM

Atlas reads companies, sites, contacts, devices and tickets from ConnectWise RMM through the ConnectWise platform API, and keeps each client's documentation current from them. It only writes to ConnectWise if you turn on one of the options that does.

### Connecting

1. In ConnectWise RMM, open **Integrations → API Access** and create an API client. Give it the read permissions for companies, sites and devices; tickets read for tickets; and, if you'll use them, devices write (for Atlas links), tickets create and sites read (for ticket notes and expiry tickets; a new ticket goes on a site), and **Automation read** and **Automation create** (for password rotation). Copy the client ID and secret.
2. In Atlas, open **Import & export → ConnectWise RMM**.
3. Choose the **Region** your ConnectWise tenant is in: **North America**, **Europe** or **Australia**.
4. Enter the **Client ID** and **Client secret**. The secret is encrypted with the master key; afterwards the field says **Saved and encrypted. Leave empty to keep it.**
5. Leave **Sync every hour** ticked unless you only want to sync by hand.
6. Choose **Connect**. Atlas checks the credentials before saving them. Later, the button is **Save and test**.
7. Link each ConnectWise company to an Atlas client, or let Atlas create the client.
8. Choose **Sync now** for the first sync, and watch its progress.

### What to sync

| Option | What it brings in |
|---|---|
| **Sites** | Each linked company's sites, as locations. |
| **Contacts** | Each company's contacts, matched to existing ones by email. |
| **Devices** | Devices as assets, updating same-named ones. Manufacturer, model, serial number, operating system, last check-in, online status and endpoint protection come across; fields you add yourself are kept. A device the RMM no longer has is archived. |
| **Tickets** | Read-only, for the ticket cards and dashboard. Needs the tickets read permission. |
| **Software and sign-ins** | Each device's installed software and who signs in, and which host each virtual machine runs on. |
| **BitLocker keys** | Recovery keys kept in a device custom field, saved to the client's vault and linked to the device. Off until you turn it on. |

**Save devices in** chooses the asset layout. **Automatic** uses the **Endpoints** layout when there is one (a layout called Devices or Computer Assets is renamed to Endpoints), otherwise Configurations. Warranty dates for Dell, Lenovo and HP are looked up when ConnectWise has none.

### Options that write to ConnectWise

These change data in your ConnectWise tenant, so they're off until you turn them on.

| Option | What it does |
|---|---|
| **Atlas links** | Writes each device's Atlas address into its **Atlas link** custom field on every sync, so technicians can jump from ConnectWise to Atlas. Add that device custom field in ConnectWise first. Needs devices write. |
| **Ticket notes** | Lets technicians add internal notes to tickets from Atlas, and adds a note to the ticket whose number is in the reason when someone reveals a password (never the password itself). Needs tickets create. |
| **Expiry tickets** | Opens one ticket for each domain, certificate, licence or warranty of a linked client coming due, on every sync. **Days before it expires** (1 to 180) sets how far ahead, and **Service board** the board's name (empty uses the first active board the company's site can take). Needs tickets create. |

**Disconnect** deletes the secret from Atlas. Synced devices stay.

Client portal tickets go to ConnectWise PSA, not RMM: see [ConnectWise PSA](#connectwise-psa).

## ConnectWise PSA

ConnectWise PSA (also called ConnectWise Manage) is where your service desk works tickets. Atlas connects to it with an API member's keys, so your clients can open real PSA service tickets from Atlas, with PSA ticket numbers, and so each linked client's PSA tickets show on the ticket cards and the ticket dashboard. This is separate from [ConnectWise RMM](#connectwise-rmm): RMM tickets (the ones numbered like `133023.1670`) never become PSA tickets, so client tickets go to PSA through this connection only.

Atlas writes to PSA only when a client opens a ticket or answers one, and only with **Client portal tickets** on.

### Setting up PSA for Atlas

You need a PSA administrator to set up three things once.

1. **A security role for Atlas.** In PSA, open **System → Security Roles** and add a role, such as `Atlas API`. Give it:
   - **Companies → Company Maintenance**: Inquire level **All**, so Atlas can list companies to link.
   - **Companies → Contacts**: Inquire level **All**, so Atlas can make the person who asks the ticket's contact.
   - **Service Desk → Service Tickets**: Add and Inquire level **All**, so Atlas can open and read tickets.
   - **Service Desk → Service Ticket Notes** (in some versions **Notes** under Service Tickets): Add and Inquire level **All**, so Atlas can read and add Discussion notes.
   - **System → Table Setup**: Inquire level **All**, so Atlas can read service boards and ticket sources.
2. **An API member.** Open **System → Members → API Members**, add a member (for example `Nexus Atlas`) with the role above and a location and department, and save. On the member's **API Keys** tab, add a key. Copy the **Public key** and **Private key**. PSA shows the private key once only.
3. **A client ID.** Sign in at `developer.connectwise.com`, open **Client IDs**, and create one for Atlas. Every PSA API request carries it. It's free.

You also need:

- **The site address** of your PSA API, such as `api-na.myconnectwise.net` (North America), `api-eu.myconnectwise.net` (Europe) or `api-au.myconnectwise.net` (Australia). If you host PSA yourself, use your own server's address. Atlas uses HTTPS only.
- **The company ID** you type when you sign in to PSA.
- **The service board** client tickets should go on, such as `Help Desk`. It must be active.

### Connecting to PSA

1. In Atlas, open **Import & export → ConnectWise PSA**.
2. Enter **Site**, **Company ID**, **Public key**, **Private key** and **Client ID**. The private key is encrypted with the master key; afterwards the field says **Saved and encrypted. Leave empty to keep it.**
3. Leave **Sync every hour** ticked unless you only want to sync by hand.
4. Choose **Connect**. Atlas signs in and lists your PSA companies before saving anything, so a wrong key never replaces a working connection. Later, the button is **Save and test**.
5. Link each PSA company to its Atlas client in the list that appears (Atlas suggests matches by name), or choose to skip it. Save the links.
6. Choose **Sync now** for the first sync, and watch its progress. It brings in each linked company's open tickets and those closed in the last 90 days.

Only administrators can see and change this page, and changes to the connection need a recent sign-in. Saving the connection, changing links, changing options, starting a sync and disconnecting each write an entry to the security log.

**Disconnect** deletes the keys from Atlas and removes the copies of PSA tickets from Atlas. Nothing changes in PSA.

### Client portal tickets

**What it does.** Your clients' own staff, signed in to Atlas with a client account, get a **New ticket** button under **Ticket details** on their organization's overview. The ticket they write is opened in ConnectWise PSA straight away, for the PSA company their Atlas client is linked to, on the service board you name, and gets a normal PSA ticket number. It shows in their ticket list at once, and the hourly sync keeps its status up to date. On each PSA ticket, **Conversation** shows the notes your technicians add to the ticket's **Discussion** (and its **Resolution**), and lets the client answer. Their answer is added to the ticket as a Discussion note, so your technicians see it in PSA with everything else. Technicians can open tickets from the same button.

**Why use it.** Clients can ask for help from the place they already look up their documentation, without an email that someone has to copy into PSA. Every request lands on the right company and board as a real PSA ticket, with the person who asked as its contact, and keeps its whole conversation in PSA, where your team already works.

**What clients never see.** **Internal** notes are never sent to a client account, and nor is anything else that isn't Discussion or Resolution. Clients see only tickets of the clients they have access to.

**Prerequisites**

- A working ConnectWise PSA connection (see [Connecting](#connecting-to-psa)), with the security role above.
- The client is linked to its PSA company under **Import & export → ConnectWise PSA**.
- An active service board in PSA for client tickets.
- The client's staff have client accounts (see [For your clients](client-portal.html)). Both **Client viewer** and **Client editor** accounts can open tickets: asking for help doesn't change their documentation.

**Turn it on**

1. In Atlas, open **Import & export → ConnectWise PSA**.
2. In **Portal ticket board**, type the name of the service board, exactly as PSA shows it (capitals don't matter), such as `Help Desk`. It saves when you leave the box. Until a board is named, **Client portal tickets** can't be ticked; emptying the box later turns portal tickets off.
3. Tick **Client portal tickets**. It saves at once.
4. Choose **Sync now** once, so every linked client's existing PSA tickets are in Atlas before clients start using it.

Atlas picks the ticket's **Source** for you: a source whose name contains **Portal** if you have one, otherwise one named **Web**, otherwise one that sounds like Atlas or a system (**Internal**, **System**, **Automation**, **Other**), otherwise the first source. To control it, add a source called **Client Portal** in PSA under **System → Setup Tables → Service Source**.

**What goes into PSA.** The ticket goes on the linked company and the board you named. Its summary is the client's **Summary** (up to 100 characters, PSA's limit). Its contact is the PSA contact at that company whose email address matches the person's Atlas account. If PSA has no such contact, the ticket carries their name and email address instead, so your technicians can still reply. Its initial description is the client's **Details** followed by a line saying who asked, such as *Submitted by Dana Lee (dana@harbordental.com) through Nexus Atlas.* Replies arrive as Discussion notes ending *(Reply from Dana Lee through Nexus Atlas)*.

**If PSA is slow.** If PSA doesn't answer within two minutes, Atlas looks for the ticket it just asked for before reporting a failure, so a ticket PSA did open is shown rather than opened twice.

**Limits.** Each person can try to open up to 20 tickets an hour from Atlas (a try PSA refuses counts too); after that Atlas asks them to wait. Atlas never writes passwords or attachments into tickets. The security log records each ticket opened and each reply sent, with the ticket number and who did it, but not what they wrote.

**Check that it works**

1. Sign in as a client account (or ask a client contact to), open their organization, and find **Ticket details**.
2. Choose **New ticket**, fill in **Summary** and **Details**, and choose **Open ticket**. A message gives the ticket number, which is a plain PSA number such as `6209`, with no dot.
3. In PSA, open **Service Desk → Service Board**, choose the board, and find the ticket under the linked company. Its contact is the person, and its description ends with the *Submitted by* line.
4. In PSA, add a note to the ticket's **Discussion**, and an **Internal** note. In Atlas, open the ticket's **Conversation**. The Discussion note is there; the internal one isn't.
5. Write a reply in **Conversation** and choose **Send reply**. It appears in PSA as a Discussion note.
6. In Atlas, open **Admin → Security log**. It lists *ConnectWise PSA ticket opened from Atlas* and *ConnectWise PSA ticket reply added from Atlas* with the ticket number.

**Troubleshooting**

| What you see | Why, and what to do |
|---|---|
| **Connect** says *ConnectWise PSA refused the sign-in* | The company ID, public key, private key or client ID is wrong, or the API member is inactive. Copy them again; a new private key needs a new key on the **API Keys** tab. |
| *ConnectWise PSA refused /…: the API member's security role doesn't allow it* | The security role is missing the permission for that path (for example `/service/tickets` or `/company/contacts`). Add it as listed in [Before you start](#setting-up-psa-for-atlas), then try again. |
| *ConnectWise PSA could not be reached* | The **Site** is wrong, or this server can't reach it. Check the address, and that the server can open HTTPS connections to it. |
| No **New ticket** button | **Client portal tickets** is off, no board is named, or this client isn't linked to a PSA company. Check all three under **Import & export → ConnectWise PSA**. Client accounts also need access to the client. |
| *Opening tickets from Atlas is off for this client* | The same: the option was turned off or the company unlinked after the page opened. Reload the page after fixing it. |
| *ConnectWise PSA has no active service board named "…"* | **Portal ticket board** doesn't match an active board. In PSA, check the board under **System → Setup Tables → Service Board**, copy its exact name, and type it again. |
| *ConnectWise PSA returned 400 for /service/tickets* | PSA refused the ticket and says why after it, often a required field on that board (such as a type or a priority) or a company that is inactive. Fix it in PSA's board setup, then try again. Nothing was opened. |
| *ConnectWise PSA didn't confirm the ticket in time, and it wasn't found afterwards* | PSA didn't answer and Atlas couldn't find the ticket. Check the board in PSA before trying again, in case it appears late. |
| *ConnectWise PSA opened the ticket but did not say its number* | PSA created the ticket but answered without its ID. It appears after the next sync; don't open it again. |
| *Too many attempts. Wait a few minutes and try again.* | The person tried to open 20 tickets within the hour. Wait, or open further tickets in PSA directly. |
| The ticket has no contact in PSA, only a name and email | PSA has no contact with that email address at the linked company. Add the email to the person's contact in PSA, and later tickets use it. |
| A client can't see a technician's note | Only Discussion and Resolution notes reach clients. Move the text into a Discussion note in PSA. |
| The ticket's status doesn't change in Atlas | Status comes from the hourly sync. Choose **Sync now**, or check **Sync every hour** is ticked. |
| **Conversation** shows replies but no reply box | **Client portal tickets** is off. Clients can still read replies on existing tickets. |

## Microsoft 365

**Import & export → Microsoft 365** documents each client's tenant from one multi-tenant app registration with `Directory.Read.All`, consented once per tenant. Users become contacts (with their licences and admin roles), paid subscriptions become License assets with seats bought and assigned, custom domains become Domain assets, and a Microsoft 365 asset lists the tenant's domains, subscriptions and administrators.

For **GDAP**, choose **GDAP — sign in with a partner Microsoft account**, save the partner tenant and multitenant app, and connect the partner account. Add Microsoft Graph delegated **Directory.Read.All**, **DelegatedAdminRelationship.Read.All**, and **LicenseAssignment.ReadWrite.All** permissions, then grant administrator consent. Each customer also needs delegated application consent and an active GDAP relationship with suitable roles assigned to the partner user's security group. Load customers and map each tenant to its Atlas client.

**Clients → a client → Licenses** reads Microsoft subscriptions and user assignments through that GDAP connection. Direct assignment/removal requires an Atlas administrator with recent authentication and a supported Microsoft customer role such as **License Administrator** through GDAP. Existing partner connections must reconnect and grant the additional license permission before making license changes. Atlas refuses an application-credential fallback when GDAP fails. Group-derived licenses remain managed through Microsoft Entra group membership; purchasing subscriptions and changing reseller billing terms remain with the reseller. Failed or unconfirmed requests are recorded in the security log; refresh before retrying an uncertain change.

## Bitdefender GravityZone

Atlas reads each client's endpoint protection from Bitdefender GravityZone. It's read-only: Atlas never changes anything in GravityZone.

1. In GravityZone, open **My account → API keys** and create a key with the **Network** and **Companies** APIs turned on. A service API key (**Accounts → Service API keys**) works too.
2. Copy the **Access URL** from **My account → Control Center API**. It's usually `https://cloud.gravityzone.bitdefender.com/api`.
3. In Atlas, enter both under **Import & export → Bitdefender GravityZone** and choose **Connect**. Atlas tries the key before saving it, and keeps it encrypted.
4. Link each GravityZone company to a client. A company's name is matched to a client's to suggest the link.

The sync runs every hour, and **Sync now** runs it straight away.

- **The client's overview** gets a **Bitdefender** card. It counts endpoints that are infected, need attention or are protected, and lists what needs attention first, with the reason. It also lists **devices without Bitdefender**: devices the RMM knows about that GravityZone doesn't manage, so they're likely unprotected.
- **Each device** matched to a GravityZone endpoint shows its state: policy, licence, last seen, agent version, risk score, signatures, and which modules are on.
- **Needs attention** means the licence has expired or isn't active, the malware signatures are out of date, the policy isn't applied, the endpoint is isolated, it hasn't been seen for 7 days, malware was removed in the last day, or the agent is out of date.
- **Matching:** endpoints are matched to the client's assets by name, host name or MAC address. Turn on **Add endpoints that aren't in Atlas as assets** to add the rest, in the same layout ConnectWise RMM uses.
- **Disconnecting** deletes the key and the synced endpoint states. Assets stay.

## Export

- **One client:** **Export** on the client's page. See [Clients](clients.html#export-a-client).
- **Everything:** System status → **Back up now** makes a full encrypted backup. See [Keeping Atlas healthy](looking-after-atlas.html#backups).
- **The API:** with an API key, `/api/v1/openapi.json` describes every endpoint.

## BitLocker collector

**Vault → BitLocker collector** gives you a script for your RMM that reads each Windows machine's BitLocker status and recovery keys and sends them to Atlas.

1. **Make an enrollment.** Choose the client, a name, and whether it covers all of the client's devices or one. The script downloads at once. Keep the file as you would a password: it holds an upload token, and Atlas can't show it again.
2. **Add it to your RMM** as a PowerShell script for that client, run as **SYSTEM**. It needs no parameters.
3. **Try it on one machine.** It prints one line of counts (never keys) and exits 0 when the report was uploaded.
4. **Schedule it** every 6 hours, and after a recovery key is rotated.

Machines are matched to assets by serial number, then by name. **Revoke** an enrollment, or **Block** one machine, to stop uploads; keys already saved stay in the vault. The script only reads: it can't turn BitLocker on or off or change a key.

## Automatic password rotation

![Password rotation](../images/manual/rotation.png "Vault → Password rotation.")

**Vault → Password rotation** changes local administrator and Active Directory service account passwords on a schedule, through ConnectWise RMM.

1. Connect ConnectWise RMM, with **Automation read** and **Automation create** on its API key.
2. Import `deploy/rmm/Invoke-AtlasPasswordRotation.ps1` into ConnectWise RMM as a PowerShell script, enter its ID on the page, and tick **Rotate passwords automatically**.
3. Add a policy for each account type: how often, and the password rules. A policy for **All clients** is the default; a client's own policy replaces it.
4. Choose the passwords: the client, the vault entry, and the device the script runs on. For an AD service account, choose a domain controller.

**How it stays safe.** The script sends the new password to Atlas before changing anything, using a token good for that one rotation for two hours. Only a confirmed change replaces the password in the vault; the old one moves to its history. A failure keeps the old password, is recorded in the access history and security log, emails administrators, and is tried again after a day.
