---
title: Documentation
nav: Documentation
out: manual/documentation.html
group: Using Atlas
order: 4
number: 4
summary: Assets and layouts, documents and the knowledge base, checklists, links, files, version history, sharing and QR labels.
---

# Documentation

Documentation is what Atlas is for: every device, procedure and fact a technician needs, kept where the next person will find it. This chapter covers assets, documents, the knowledge base and checklists, and the features they share.

## Assets

An asset is anything you look after: a server, a workstation, a firewall, a switch, a domain name, an SSL certificate, a software licence. Each asset uses a **layout** that decides its fields. Atlas comes with layouts such as Configurations, Endpoints, Networks, Domains, SSL certificates and Licenses, and administrators can add their own.

![The assets list](../images/manual/assets.png "Docs → Assets lists every asset you can see, across all your clients.")

**Docs → Assets** lists assets across every client you can see. A client's **Assets** tab lists just theirs, grouped by layout.

### Find, filter and sort assets

The list narrows as you type or choose, and every filter combines with the others:

- **Filter by name, IP, serial…** searches names, clients, layouts and every field. Each word you type has to match somewhere, so `dell 2022` finds a Dell server running Windows Server 2022.
- The layouts down the side (or across the top on a phone) show one layout, such as **Endpoints** or **Domains**.
- **All clients** narrows the list to one client. (A client's **Assets** tab already shows just that client.)
- **Active**, **Inactive** and **Retired** show assets with those statuses. Choose more than one to see each of them; choose none to see all.
- **Updated any time** can show only assets updated in the last 7, 30 or 90 days, or those **Not updated in a year**.
- **+ Filter by field…** filters on one of the layout's fields, such as **Operating system**, **Manufacturer** or **Type**. A choice field offers its choices; a text field matches what you type anywhere in it. Either can find assets where the field **has a value** or **is blank**. With **All assets** chosen, you can filter on the fields of every layout in the list.

**Showing 3 of 48 assets** tells you how far the filters have narrowed the list, and **Clear filters** removes them all (the layout stays). The filters are kept in the page's address, so you can bookmark a filtered list or send it to a colleague, who sees the same assets if they can open them.

Choose a column heading, such as **Name**, **Client**, **Status**, **Updated** or one of a layout's columns, to sort by it, and choose it again to reverse the order. The **Sort** menu and the arrow beside it do the same. Assets with nothing in a field's column always come last. Your sort is remembered on any computer you sign in to.

**Save view** keeps the current filters and sort under a name, such as "Windows endpoints with no warranty date", and **Saved views…** brings one back. You can keep up to 20, and only you see them. To remove one, choose **Save view** and the bin beside it.

### Add an asset

1. Open the client and go to its **Assets** tab, then choose **Add asset**.
2. Pick the layout.
3. Fill in the fields. Atlas checks them as you save: an IP address, date, email address or web address in the wrong format is pointed out before anything is saved.
4. Choose **Save**.

### Smart paste

Rather than typing a computer's details, let it tell you:

1. On the computer, run one of these:
   - **Windows:** `ipconfig /all`, `systeminfo` or, in PowerShell, `Get-ComputerInfo`. Several can be pasted together.
   - **Mac:** `system_profiler SPHardwareDataType`.
   - **Linux:** `hostnamectl`.
2. Copy what it prints.
3. In the new asset, choose **Smart paste** and paste it. Or simply paste it into the **Name** box: Atlas recognises it and opens Smart paste for you.

Atlas shows what it found: the name, hostname, IP address (the network card with a gateway comes first), MAC address, manufacturer, model, serial number, operating system and type (server, laptop or workstation). Empty fields are ticked to fill. A field that already holds something different shows what it would replace, and stays unticked. Choose **Fill in**, check the fields, then save. The text is read in your browser and isn't sent or kept.

It works with any layout that has fields with these names, not only Configurations.

Devices from ConnectWise RMM and tenants from Microsoft 365 arrive as assets on their own; you don't need to add them by hand. Fields filled by a sync are kept up to date by the sync, and fields you add yourself are left alone.

### An asset's page

![An asset's page](../images/manual/asset.png "An asset: its details on the left; BitLocker, related items, files and version history on the right.")

An asset's page shows its **Details** (every field in its layout), **Notes** and **Activity**. Down the right are:

- **BitLocker**, for Windows machines that report through the BitLocker collector or ConnectWise RMM. See [Passwords](passwords.html#bitlocker-recovery-keys).
- **Related**, the passwords, documents, contacts and locations linked to it.
- **Files**, anything attached.
- **Version history**, every saved version.

The buttons at the top are **QR label**, **Check warranty** (for hardware with a serial number), **Archive** and **Edit**.

### Archive instead of deleting

**Archive** takes an asset out of lists and counts without losing it. **Show archived** on the assets list shows them, and **Restore** on an archived asset brings it back. Assets that a ConnectWise RMM sync no longer finds are archived for you.

### Warranty dates

For Dell, Lenovo and HP hardware with a serial number, Atlas looks up the warranty end date from the vendor's public warranty check when the asset is saved, and during each ConnectWise RMM sync. **Check warranty** looks it up again now. A date someone typed in is never replaced.

### QR labels

Choose **QR label** on an asset, or **QR labels** on a client's Assets tab for everything shown. Pick a label size and print. Scanning a label with a phone opens that asset in Atlas after signing in. The label itself shows only the name, the client and the serial number, so nothing sensitive is printed.

## Documents

Documents are runbooks, procedures, how-tos and notes. They live in a client's **Documents** tab, or in the MSP **Knowledge base** for procedures that apply to every client.

![A document](../images/manual/document.png "A document from the knowledge base, with Related, Files and Version history beside it.")

### Write a document

1. Choose **New document**, on a client's Documents tab or in **Docs → Knowledge base**.
2. Give it a **Title**, and choose a **Folder** if you use them.
3. Write it. The editor has headings, bulleted and numbered lists, checklists, tables, code blocks and links.
4. Set its **Status**: **Current**, **Needs review** or **Draft**.
5. Optionally set **Review by**. Atlas reminds you on the Expirations page when the date comes, so procedures don't quietly go out of date.
6. Choose **Save**.

### Still accurate? Verify it

When you've checked a document and it's still right, choose **Verify**. The document shows **Verified 12 days ago by Alex**, so the next person knows it can be trusted.

- **Verifying isn't an edit:** the version and "last updated" stay as they were.
- **Needs review clears:** a document marked **Needs review** goes back to **Current**.
- **The review comes round again:** if it has a **Review by** date, that date moves six months ahead, so the reminder repeats.
- **Stale documents are marked:** one that hasn't been verified or edited for six months shows **Not verified**, or **Last verified** in amber. The documentation health report lists them too.

### The knowledge base

**Docs → Knowledge base** is your team's own library: procedures, standards and how-tos that aren't about one client. Client accounts never see it. **New folder** keeps it organized.

**Template library** offers ready-made runbooks and how-to guides to start from. Runbooks go into a Runbooks folder. Guides go into an **Atlas guides** folder, titled by who they're for:

- **Technician:** your first day, finding anything, documenting a device, writing documents, handling passwords, running checklists, the extension and Atlas for Windows, expirations, client reviews, and what to do when you can't see something.
- **Client:** for a client's own staff: what their account shows, keeping it secure, viewing a shared password, finding their documentation, keeping it up to date, receiving a one-time link, and reading your reports.
- **Admin:** setting Atlas up, people and access, client accounts, offboarding, single sign-on, the vault, a weekly health check, backups, integrations, and API keys and webhooks.

You edit them like any other document, so add your own help desk details and procedures. Client accounts never see the knowledge base, so send a client guide to a client's staff with **Share**.

### Share a document with a link

**Share** on a document makes a link anyone can open without signing in, for a how-to you want to send to a client's staff.

- They see that one document, always as it is now, and nothing else in Atlas.
- Choose how long the link works. Atlas shows how often it has been opened.
- **Revoke** stops the link working at once.

> [!warning] Check before you share
> Anyone with the link can read the document. Don't share one that contains passwords or anything about another client.

## Checklists

Checklists are procedures you work through step by step: onboarding a new user, decommissioning a laptop, patching a server. A checklist is the reusable template; a **run** is one time you work through it for a client.

![A checklist run](../images/manual/checklist-run.png "A run: tick steps as you go, add notes, and assign it to someone with a due date.")

### Make a checklist

1. Go to **Docs → Checklists** and choose **New checklist**, or **Template library** to start from one of 13 ready-made checklists (client and user onboarding and offboarding, endpoint setup and decommission, server patching, backup verification, Microsoft 365 setup, firewall change, password rotation, incident response, SSL and domain renewal).
2. Give it a **Title** and choose **Add a step** for each step.
3. Make it available to every client, or to one.

Steps are copied into each run when it starts, so changing a checklist later doesn't change work already under way.

### Run a checklist for a client

1. On the client's **Checklists** tab, choose **Start a checklist**.
2. Pick the **Checklist** (or write a one-off list of **Steps**), and choose who to **Assign to**.
3. Tick each step as you do it. Atlas records who ticked it and when. **Add a note** records what you found.
4. Set a **Due** date if it has one. An overdue run is marked.

**Markdown** downloads the run as a text file, and **Print or PDF** gives you a printed record for the client.

## Link related items

Every asset, document, password, contact and location has a **Related** section. Choose **Link** to connect it to others: the firewall to its runbook, its admin password and the site it's in. Links work both ways, so the runbook shows the firewall too, and the client's **Map** tab draws them all.

## Files

Drag files onto the **Files** section of any asset or document to attach them, or choose **Upload**. Images that pass a content check show inline; other files download. Files are stored outside the web server's reach under random names.

## Version history

Every save keeps the previous version.

- **Version history** lists every version with who saved it and when.
- **Compare** shows what changed between two versions, line by line, and **Restore version** puts an old one back as a new version.
- If someone else saved while you were editing, Atlas tells you instead of overwriting their work. Copy your changes, reload, and apply them again.

## Asset layouts

Administrators manage layouts under **Admin → Asset layouts**. A layout has a name, an icon and fields. Each field has a type: **Text**, **Long text**, **Number**, **Date**, **Choice**, **Multiple choice**, **Yes / no**, **Web address**, **Email**, **Phone**, or **IP address or subnet**. A date field can be ticked as an **Expiry date**, which puts it on the Expirations page and in expiry alerts.

## Duplicates

Imports and syncs sometimes create the same thing twice. **Admin → Duplicates** lists assets, contacts and locations with the same name in the same client, and clients with the same name. Choose the record to keep and merge the rest into it: blank fields are filled in, links and files move over, and merged assets are archived so they can be restored.
