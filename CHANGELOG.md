# Changelog

All notable changes to MSP Atlas are documented here. The project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **Pinned reports.** Pin a saved report template from **Reports → Templates** and it appears in a **Pinned reports** card on your dashboard. One click opens it on Reports, set up and ready to run. Up to eight per person.

## [2.2.0] - 2026-10-23

### Added

- **Alerting center draft workspace.** Administrators can create separate email and Teams messages with safe fields, draft rules for clients, reminder days, item types, severities and staff recipients, and preview messages and rule conditions without sending anything. Open it from **Email & alerts → Open alerting center**. Drafts are saved with conflict protection. Existing automatic alerts continue using their current settings; activating these drafts will follow in a later update. See [Alerting center](docs/ALERTING.md).

## [2.1.1] - 2026-10-22

### Fixed

- **Teams alerts use your connected Microsoft account.** Azure Bot registration and installation are no longer required. Channel mappings, discussions, automatic alerts, digests, delivery history and resolution threads remain available. Notifications wait for reconnection without consuming retries when Microsoft requires sign-in again. The obsolete bot app-package setup has been removed.

## [2.1.0] - 2026-10-22

### Added

- **Microsoft Teams integration.** Map each client to a Teams channel. Staff can read posts and discussions, create posts and replies, and edit their own Atlas-created messages. Automatic bot notifications cover expirations, document reviews, breached passwords and confirmed infection events, with a separate optional security channel, daily digests, reminder milestones, deduplication and delivery history. Administrators can download a tenant-specific Teams app package and connect Microsoft under Administration → Microsoft Teams. See [Teams setup](docs/TEAMS.md).

## [2.0.2] - 2026-10-22

### Fixed

- **Bitdefender finds a partner's customer companies.** A partner account listed only its own company. Atlas now lists every company it manages: those directly under it, those in company folders, and those under sub-partners (resellers). Each endpoint stays with the company it belongs to, even when a partner-level listing returns other companies' endpoints too. When GravityZone asks Atlas to slow down, Atlas now waits as long as it asks, up to a minute.

## [2.0.1] - 2026-10-22

### Added

- **Bitdefender GravityZone.** Connect GravityZone under **Import & export** with an API key from your own console, and link its companies to clients. Atlas reads each client's endpoint protection every hour. It's read-only, and the key is kept encrypted.
  - **A Bitdefender card on the client's overview** counts infected, needing attention and protected endpoints. It lists what needs attention first, with the reason: an expired licence, out-of-date signatures, a policy not applied, not seen for a week, and so on.
  - **Devices without Bitdefender:** devices the RMM knows about that GravityZone doesn't manage, so they're likely unprotected.
  - **Each device** shows its Bitdefender state, policy, licence, agent version, risk score and modules.
  - **Matching:** endpoints are matched to assets by name, host name or MAC address. Optionally, the rest are added as assets.

## [2.0.0] - 2026-10-22

The Landmark Update brings expanded reporting, client health scores, a refreshed workspace, and Atlas for Windows 1.0. See [the upgrade guide](docs/UPGRADING-2.0.md) before updating.

### Added

- **Microsoft 365 reports, like the IT Health Tech portal's.** A new **Microsoft 365** group in the report library holds two reports. Both read through the GDAP connection.
  - **Microsoft 365 accounts** lists every account in each linked tenant: enabled or blocked, member or guest, its licenses, and its usage location. It flags blocked accounts that still hold licenses, and licensed accounts with no usage location.
  - **Microsoft 365 usage** covers the last 30 to 180 days. It shows each licensed account's last activity in email, Teams, OneDrive and SharePoint, and flags accounts with none. It then has a section each for Exchange email (sent, received, read), Teams (chats, calls, meetings), OneDrive and SharePoint (files viewed, synced and shared), and the Microsoft 365 apps (Windows, Mac, mobile, web).
  - **Permissions.** The usage report needs the **Reports.Read.All** permission, which Atlas now requests when the partner account connects. It also needs a GDAP role that can read usage reports, such as Reports Reader. Existing connections must reconnect once; until then, the report explains what's missing.
  - **Hidden names.** If a tenant hides names in its reports, the report says where to turn that off.
- **Savings finder report.** What each client pays for and doesn't use, priced per month and per year:
  - Unused seats on tracked subscriptions and in Microsoft 365, read live through GDAP.
  - Microsoft 365 licenses held by accounts whose sign-in is blocked, usually people who have left.
  - Renewals coming up, with what each costs and what cutting its unused seats saves before it renews.

  Microsoft seats are priced from your tracked subscription of the same name, or estimated at Microsoft's list price and marked "(list)". Nothing is guessed: subscriptions without recorded assignments are listed in a notice instead of counted.

- **Cyber insurance readiness report.** The questions cyber insurers ask, answered for each client from what Atlas holds, with the evidence and its source for every answer. It covers 13 questions:
  - MFA, endpoint protection, encryption, supported operating systems, and devices managed and up to date.
  - Backups with a restore test in the last 12 months, Global Administrators, local admin rotation, and password breaches and reuse.
  - Email spoofing protection: each domain's DMARC record is looked up live when the report runs.
  - A written incident response plan, a continuity plan, and security awareness training.

  Answers are Yes, Partly, No or **Not evidenced**. What Atlas can't see is never counted as Yes.

  **Gaps to close before renewal** lists what to fix, refusals first, and the readiness summary gives each client a percentage.
- **Clearer report PDFs.** Columns are as wide as what they hold, so evidence and names wrap less and reports run to fewer pages. States and answers are coloured: Offline, Not encrypted and No in red, Partly in amber, Yes and Online in green. In a whole-report PDF, a one-client summary shows as figures.

- **Client health score.** Every client has a score from 0 to 100, beside its name: Healthy, Good, Needs attention or At risk, with how far it moved in 30 days.
  - It is made of four weighted parts: security (passwords, endpoint protection, encryption), endpoints (online and checking in), documentation (the essentials on record and reviews on time), and renewals (domains, certificates, warranties and subscriptions in date).
  - A part with nothing to measure is left out, never assumed healthy.
  - Choose the score to see each part and **What would raise it most**: every gap, with the points fixing it would add, linked to where you fix it.
  - Atlas keeps a score per client per day, so each has a trend.
  - The dashboard's new **Client health** card lists clients lowest first, and the client list has a **Health** column.
  - The executive summary report includes the scores, and the review pack shows the score on its cover. Scores are for staff only.

- **Client review pack.** A quarterly business review for one client in a single branded PDF, from one click on **Review pack** in the client's header.
  - It brings together the executive summary, security posture, service review and upcoming renewals for the last quarter, or any period from 30 days to a year.
  - It opens with a cover page: the client, the period, how much of each report needs review, and contents with page numbers. Each report follows on its own pages with its charts, and one-client summaries show as figures.
  - It's also under Reports as **Client review pack**, so it can be compared with the last one, shared with the client by link, or scheduled every quarter.
- **Report PDFs are named after the report**, such as `Harbor Dental quarterly review 2026-10-21.pdf`, and a shared report's page offers the whole report as one PDF.

- **Scheduled reports, emailed.** Set up any report, choose **Schedule**, and Atlas emails it every week, month, or quarter, on the day and at the hour you choose, to up to 20 people.
  - Each run captures a fresh snapshot with the owner's access at that moment, kept in their history so **Compare with** works on it.
  - The email carries a summary and the whole report as a branded PDF. For a report about one client it can include a 30-day client link.
  - The **Scheduled** tab shows when each schedule runs next and how the last delivery went, down to any address that refused it. You can send one now, pause it, change it, or delete it.
  - Two servers never send the same report twice. A schedule whose owner can no longer sign in stops rather than sending, and deleting a client removes its schedules.
- **Report alerts.** A schedule can run every day, and send only when something needs review, or only when something new needs review since the last report sent. An alert lists just the new items.
  - For example, a daily **Security posture** alert tells you the morning after a password turns up in a breach or a device loses its protection.
  - A daily **Domains & SSL** alert warns as each certificate starts to expire.
  - Quiet days send nothing and add nothing to your history.
- **Delivery log for scheduled reports.** Each schedule's **Deliveries** list shows every email it sent or tried to send, recipient by recipient, and why any was refused. Any one can be sent again, as the same snapshot, without running the report again.
- **Emails in your brand.** Atlas's emails now use your brand name and accent colour from Administration → Theme, instead of a fixed green.
- **Report PDFs can cover the whole report.** Every section is printed, with the summary and charts, for emailed reports.
- **Code signing for Atlas for Windows.**
  - Once Azure Artifact Signing is set up, releases sign the app and its setup program, so Windows names your organization as the publisher instead of warning about an unknown one.
  - Setup takes about ten minutes plus Microsoft's organization check, costs about US$10 a month, and stores no password in GitHub. It's described in `docs/CODE-SIGNING.md`.
  - Until it's set up, releases are built unsigned, as before.
- **Atlas for Windows runs natively on Arm PCs.** The setup program now carries an ARM64 build alongside the x64 one and installs whichever matches the PC. It's the same download and the same in-app update. Upgrades also start from a clean app folder, so nothing is left over from an older version.
- **Atlas for Windows works with screen readers and contrast themes.**
  - Every page is checked with Axe.Windows (the engine behind Accessibility Insights) on each build.
  - Buttons that showed an icon and text but had no name for screen readers now have one.
  - Each earlier password's buttons say which password they're for.
  - The sidebar, account badge, and highlighted document text use Windows' own colours in a high contrast theme.
- **Atlas for Windows uses your favicon as its icon.**
  - The favicon set under **Administration → Theme** becomes the app's icon: its window and title bar, taskbar button, tray icon, and its Start menu, desktop, and pinned taskbar shortcuts.
  - Windows can't draw SVG, so when the theme is saved the browser also makes a 256-pixel PNG of the favicon for the app. PNG and ICO favicons are used as they are.
  - The app picks up a new icon when it starts and with each six-hourly check. It downloads the picture only when it has changed (the server answers `304 Not Modified` otherwise), and goes back to its own icon if the favicon is removed.
  - Turn it off under **Settings → Use your Atlas's icon**.
  - The icon comes from a new public endpoint, `/api/v1/branding/app-icon`, which serves the same picture as the favicon.
- **Atlas for Windows: a Settings page.** Open it from the account menu or with Ctrl+,. It brings the app's choices together:
  - **Theme:** light, dark, or the same as Windows. The window's caption buttons follow the theme too.
  - **Search shortcut:** Ctrl+Shift+Space, Ctrl+Alt+Space, Ctrl+Shift+K or Ctrl+Alt+K. Useful when another app already uses one; if the chosen one is taken, the app says so and keeps the old one.
  - **Windows Hello and locking.**
  - **The daily notice** about what's coming due.
  - **Start with Windows.**
  - **Updates:** your version and Check for updates.
  - **Account:** the Atlas address, Open Atlas, and Sign out.
  - A note on what the app keeps on the PC.
- **Atlas for Windows: a Home page worth opening.** Under your favorites, **Coming due** lists what's overdue or due in the next two weeks, soonest first: password rotations, expiring domains, warranties, and document reviews. The line under the title greets you and says how many items are due.
- **Atlas for Windows: pages use the window.**
  - Item pages and the client overview fill the page up to a readable width instead of shrinking to their content.
  - When the window is wide, About, Related, Files and Earlier passwords sit in a column beside the page.
  - Forms put short fields two to a row.
  - The asset form's first choice is now called **Asset layout**, as in Atlas, so it no longer has two fields called Type.
  - IP address and web address labels are no longer drawn in the code font.
- **Atlas for Windows: documents look the way they do in Atlas.** Headings, bold, italic, underlined, struck and highlighted text, inline code, links, bulleted and numbered lists (nested too), checklists with what's done ticked, quotes, lines, and tables are drawn properly instead of as plain text. Code blocks have a **Copy** button. Links open in your browser, and links to Atlas pages open on your Atlas. The editor's **Preview** draws the same way.
- **Smart paste for assets.** Run `ipconfig /all`, `systeminfo` or `Get-ComputerInfo` on a Windows computer (`system_profiler` on a Mac, `hostnamectl` on Linux), and paste the output into a new asset.
  - Atlas fills in the name, hostname, IP and MAC address, manufacturer, model, serial number, operating system, and whether it's a server, laptop or workstation.
  - Paste it straight into the Name box and Smart paste opens on its own.
  - Fields that already have a value are shown with what would change, and are left alone unless you tick them.
  - The text is read in the browser and never sent.
- **Wi-Fi join codes.** A Wi-Fi password now has a **Join this network** card: a QR code that phones scan with their camera to join, with no typing. **Print** makes a guest card with the network name, the code and the password, ready to frame. The password is revealed the usual way (recorded, with a reason where required), and the code hides again after a minute. WEP, open and hidden networks are supported, and Wi-Fi entries call their username **Network name**.
- **Welcome to Atlas 2.0.**
  - Staff see a welcome card on their dashboard after the update. **See what's new** opens a page that describes each part of 2.0 in plain words, with a link to try it: reports, the client health score, smart paste and Wi-Fi codes, the cleaner workspace, and Atlas for Windows 1.0.
  - The card goes once you've opened the page or dismissed it, and that's remembered for your account, not just your browser.
  - The page stays under **What's new** in the account menu.
- **Set up Atlas.** A new page under Administration lists a new installation's first steps, each with why it matters and a link to do it:
  - two-step sign-in
  - your branding
  - email
  - importing your documentation
  - the first client
  - ConnectWise RMM
  - Microsoft 365
  - your team
  - a first backup

  Steps tick themselves off from what's really there, however they were done. Until the essential ones are finished, administrators see the next few on their dashboard.
- **Upgrade guide for 2.0** in the manual (*Running Atlas → Upgrading to 2.0*): what to check before upgrading, how each kind of installation upgrades, what's new, the few things to do after upgrading (Microsoft 365's new permission, email for scheduled reports, an SVG favicon, Atlas for Windows), and how to go back to 1.x from the pre-update backup.
- **Security posture report.** A new built-in report under Reports. For each client it shows the following:
  - **Passwords** with problems: breached, weak, reused, rotation overdue, expired, or unchanged for a year.
  - **Devices** that are offline or unprotected.
  - **BitLocker encryption**, as reported by the collector.
  - **Automatic password rotation** that is failing.

  Further sections list each password with problems, every device with its protection and encryption state, and each rotation target with its last result. **Needs review** picks out the problems.

  Access rules apply. Password names appear only for clients whose passwords you can open, and only administrators see rotation. Passwords, usernames, notes and recovery keys are never included.
- **Domains & SSL report.** A new built-in report under Reports that covers each client's domains and SSL certificates.
  - Each record shows its registrar or issuer, expiry date, days left, auto-renew setting, and the result of the latest automatic check.
  - A summary counts what has expired, what expires within the chosen window (30 days to a year), and failed checks.
  - **Needs review** picks out expired and expiring records and failed checks.
- **Software & sign-ins report.** A new built-in report under Reports, read from the ConnectWise RMM inventory.
  - It lists every application on each client's devices, flagged ones first, with the same flags as the client's Software tab: end of life, no license recorded, or over seats.
  - It also lists who signs in to each device, matched to contacts.
  - A summary counts devices reporting, applications, flags, and sign-in accounts.
- **Service review report.** A new built-in report under Reports that looks back over a chosen period, from the last 30 days to a year. It suits a monthly or quarterly review with a client.
  - It counts tickets opened and closed, tickets still open, checklists completed, documentation updated, assets added, and changes recorded.
  - It shows each client's device health at the start of the period against now.
  - It lists the tickets, completed checklists, and activity.
  - Password changes are counted only where you can open that client's passwords, and are never listed.
- **Asset fields in Asset inventory.** The Asset inventory report can add up to 12 fields from your asset layouts as columns, such as serial number, model, warranty, or IP address.
  - Templates remember the choice.
  - Long text fields are never included.
  - A field that no longer exists is left out, with a notice.
- **Compare a report with its last run.** After running a report you've run before for the same clients, choose **Compare with** to see what changed since the most recent earlier run.
  - New rows are marked **New**.
  - Changed values are highlighted, with the previous value shown.
  - Rows that have gone are listed separately.
  - **Changes only** narrows the table to what moved.
  - Values that change on every run, such as check-in times, don't count as changes.

- **Share a report with the client.** A report run for one client can be shared by a link that works for 7, 30 or 90 days.
  - The client sees that snapshot without an account: every section, its notes and sources, and a PDF of each section.
  - The page names your organization and the client, never the technician who ran it.
  - The **Share** dialog shows how often each link was opened, and **Revoke** stops a link at once.
  - Deleting the report or the client stops its links.
  - Only the person who ran the report can share it, and only with edit access to that client.
  - Making and revoking links are in the security log, and wrong links are rate-limited.

### Changed

- **Reports read like the IT Health Tech portal's.** The library, the workspace, and the results are separate cards with room to breathe, instead of one crowded box.
  - **Library.** Reports are grouped by what they answer: client reviews, licensing & spend, security & compliance, infrastructure & documentation. It folds away once a report is open; **Change report** brings it back.
  - **At a glance.** A report opens with its figures. A license report shows products, seats purchased, assigned, available, and how much is in use. The savings finder shows seats to reclaim and monthly and yearly waste. Every report shows how many rows need review, and pressing that figure filters the report.
  - **Everything at once.** Every section shows on the page, one under another, with no list to pick a section from. One search and a **Needs review only** switch cover the whole report.
  - **Easier to scan.** States show as coloured pills. Figures and amounts line up on the right. A subscription's assigned seats show as a bar against what was bought. Rows that need review carry an amber edge.
  - **Exports.** **PDF** exports the whole report. Each section has its own **CSV**.
  - **Shared links.** A shared report link shows every section the same way.
  - **Demo.** The demo now runs reports on its sample data.
- **A client's Licenses, redesigned.** It now has two list panels in the IT Health Tech portal style, with counts across the top that filter the list, a search bar, column labels, and rows with a status pill and quiet row actions.
  - **Subscriptions & seats** lists Microsoft 365 subscriptions, read live through GDAP, alongside the ones tracked in Atlas. Each shows seats used against bought, with a bar, its cost and renewal, and filters for seats available, fully used, and renewing within 30 days. Free products with thousands of placeholder seats show as having no seat limit.
  - **People & licenses** lists everyone in the tenant with their account state and licenses, filtered by licensed, unlicensed, and blocked but still licensed.
  - Who holds a subscription, and one person's licenses, open in drawers, where administrators assign and remove licenses as before.
- **Drawers for longer work.** Forms for a record, and lists opened from a card, now slide in from the right as a full-height drawer, with the page still visible behind them.
  - The forms are passwords, assets, clients, contacts and locations, subscriptions, people, groups, asset layouts, checklists, webhooks and Sends.
  - The lists are devices, tickets, warranties, trackers and applications from the overview cards, plus note and version history, webhook deliveries, sharing, and customizing the dashboard.
  - A long form scrolls inside the drawer with **Save** always in reach. A click on the dimmed page closes it, as Escape does.
  - On a phone the drawer fills the screen, and the menu slides in from the left.
  - Confirmations and short prompts stay as dialogs in the middle of the screen.
- **Administration has tabs like every other area.** Instead of a list beside the page (or a scrolling strip of buttons on smaller screens), its pages are underlined tabs, as in Overview. The tabs show the section you're in, such as People and security, and **More** lists the other pages under their headings: Data, System and Settings.
- **Branded report PDFs with charts.** PDF exports now use your logo, brand name, and accent colour from Administration → Theme, instead of a fixed blue.
  - The first page shows summary tiles (clients, rows, needs review, notices).
  - Up to three charts follow, drawn from the report itself: what needs review in each section, the spread of status columns such as online, protection or encryption, and due or expiry dates by month with overdue items first.
  - Timestamps in tables read as "2026-10-20 12:41 UTC", and alternate rows are shaded.
  - A PNG or JPEG logo is used; an SVG logo, which PDF can't embed, falls back to the brand name.

- **`/api/v1` is the supported API.** Only `/api/v1` is supported for scripts and integrations, and its description has moved to `/api/v1/openapi.json`.
  - Within v1, changes only add endpoints, fields and optional parameters.
  - A breaking change would come as `/api/v2`, with v1 kept beside it for at least the next major release.
  - The unversioned `/api` paths belong to the web app. They're internal and can change in any release, and API keys never worked there.
- **Node.js and PostgreSQL checks.** System status now warns when Node.js or PostgreSQL is older than Atlas supports (Node.js 22.12, PostgreSQL 16). It also warns six months before the server's Node.js version stops getting security fixes. CI now also runs the tests on Node.js 24 and PostgreSQL 17.

### Fixed

- **HP warranty checks say why they failed.** HP's anonymous warranty lookup now asks for a captcha, and Atlas read its refusal as "HP has no warranty on record". It now says HP refused the lookup and points to support.hp.com to look the date up by hand. Nothing is saved, and automatic lookups pause HP for 15 minutes, as for any other vendor failure.
- **Service review device trend.** Its online count (for example "35 → 38") was counted as needing review, and its arrow printed as an empty box in PDFs. It now isn't flagged, and PDFs read "35 to 38".
- Report PDFs no longer draw a one-bar "Needs review, by section" chart for a report with one section, say "1 row" rather than "1 rows", and show source times as "2026-10-21 13:05 UTC".
- **The Top bar menu style takes the sidebar colour,** like Rail and panel and Sidebar. With a Sidebar colour set under Administration → Theme, the whole top bar uses it: the areas, search, your account, and the row of pages beneath them. Before, it stayed white while its links used the sidebar's text colours.
- **Phones.** No page scrolls sideways any more. Five pages used to: the dashboard, a client's overview, Assets, the security log and Duplicates.
  - Rows that were squeezed to a word or two read properly again: password names, webhooks, groups and checklist runs.
  - The password list keeps the two copy buttons on a phone and leaves the rest to the password's page.
  - The asset list shows each asset's client under its name.
  - A client's header fits without the star dropping to its own line.
  - The dashboard and Password health show their figures in pairs.
- **Computers.**
  - **Webhooks** and **Duplicates** use the page's full width like other lists. **API keys** lines up with its heading.
  - Password health's figures sit in two even rows.
  - A client's Assets card shows full layout names.
  - Password rotation and QR label dropdowns show their whole choice.
  - A single contact no longer has a divider beside it.
  - Password rotation and BitLocker collector say "Vault" above their titles, where they live.
- The demo's **Updates** page loads, instead of showing empty placeholders.
- **Readable status colours.** Green, amber and orange status text, as on the Domains tracker, is darker in the light theme so it meets the 4.5:1 contrast ratio.
- **A link on the Certificate page** is underlined, so it doesn't rely on colour to stand out from the sentence around it.
- **Printing.** Pages print as dark text on white paper even when you use dark mode, with your brand colours in their light versions. Buttons, the favourite star, copy and show icons, empty Files and Related boxes, and the activity and version history panels are left off the page.

### Removed

- **The Atlas 0.2 importer.** `npm run migrate-legacy` and the 0.2 prototype it read from are gone. To move a 0.2 database, run the migration with Atlas 1.8 first, then update.
- **The old monthly client report.** The **Monthly report** button and its printable page are gone from the client header. The client's **Reports** tab replaces them, with PDFs, share links and scheduled delivery. Old links to the page open that tab.
- **Leftover ConnectWise PSA status lookups in ticket sync.** Ticket sync reads only the ConnectWise platform API; a ticket's state comes from its own status.

## [1.8.4] - 2026-10-21

### Fixed

- **Atlas recognizes the maker in models that just name it.** A model such as "HP All-in-One Desktop 27-cb0xxx", "HP Laptop 15-dy2xxx" or "Dell 24 AIO" left the Manufacturer blank, and **Fill in manufacturers** under **Device manufacturers** filled none of them. A model that starts with the maker's name (HP, Dell, Lenovo, ASUS, Acer, MSI, Samsung, Toshiba, Dynabook, Gigabyte, Microsoft or Apple) now fills it in, and HPE servers stay HPE. The operating system and the device's name don't count this way: "Microsoft Windows 11 Pro" runs on every maker's PCs, and a PC called HP-FRONTDESK may be any brand. After updating, choose **Fill in manufacturers** again to fill the assets you already have.

## [1.8.3] - 2026-10-20

### Fixed

- **Your menu style is back.** 1.8.0 dropped the three menu layouts and ignored the one each person had chosen. They return in the new look, and your saved choice applies again. Pick one under **Your account → Menu**:
  - **Rail and panel** (the default) shows the five areas down the left edge, with the current area's pages beside them. In Clients the panel lists every client.
  - **Sidebar** is one list of everyday pages with icons and your starred clients. Administration opens in its place, with a way back.
  - **Top bar** puts the areas across the top and the current area's pages in a row beneath, leaving the full width for the page.

  **Collapse sidebar** still narrows the rail or sidebar to icons, and phones still use the slide-out menu.

## [1.8.2] - 2026-10-20

### Changed

- **A look and menus modelled on the ITHealthTech portal.** A #f6f8fb page with white surfaces and thin borders, navy and slate type, one controlled blue (#315fbc), and Inter. The sidebar is white with a soft blue current item; the header carries the breadcrumb, a **Search or switch client** box (Ctrl K), and your name and email with sign-out. A client opens with an initials tile and its sections as one row of tabs with icons, with Checklists, Licenses, Reports, Map, Activity, and the domain and SSL trackers under **More** (which counts anything expired or expiring). Administration lists its pages in groups beside the page, like a settings screen. The Theme page's **Round** corners now stay within 5–8px. If an earlier theme made Atlas look off (a navy sidebar, large text, round corners), choose **Atlas defaults** under Administration → Theme and re-add your logo and name. (#218)
- Refined the application shell with clearer workspace tabs. Reports now use a connected three-panel workspace with compact library entries and integrated review metrics. Dashboard totals use consistent tiles, client work appears before operational integrations, and empty integration panels use compact responsive columns.

### Fixed

- **Atlas reports its real version.** 1.8.1 changed only the top-level version number, so a server running 1.8.1 still called itself 1.8.0 and the updater could keep offering an update that was already installed. Every package, and the browser extension, now carries the release version.
- Global search stays open when reopened immediately with Ctrl+K after closing it. A delayed native dialog event no longer dismisses the new search session.
- Saved report snapshots and templates are removed for every client-deletion path, including duplicate merges and organization erasure. A new migration also clears reports left for clients that no longer exist; existing migrations remain unchanged. Report client IDs are normalized before validation so letter case cannot interfere with access or cleanup.

## [1.8.1] - 2026-10-19

### Added

- Reports workspace and client Reports tab with executive summaries, asset inventory, license utilization, upcoming renewals, documentation health, and endpoint health. Private templates and immutable snapshot history retain source timestamps and missing-data notices. Search fields, attention filters, and visible columns apply to both CSV and server-generated PDF exports. Microsoft inventory uses GDAP exclusively. Scheduled reports, automatic triggers, and email delivery are planned for Phase 2.

### Changed

- Unified application shell with one collapsible sidebar, workspace navigation, header search, breadcrumbs, client switching, and account controls. White surfaces, slate typography, blue accents, compact controls, and small corner radii form the new default appearance; existing organization branding and dark mode remain supported. The previous rail, sidebar, and top-bar choices now use the unified shell.

## [1.8.0] - 2026-10-19

### Added

- Client **Licenses** section: track software subscriptions, seats, user/device assignments, per-seat costs, billing cycles, renewal dates, and cancellation status. Edits detect stale versions; changes appear in client activity and tracking records are included in client exports.
- Microsoft 365 license inventory and direct user assignment/removal through the existing **GDAP** partner connection. Tenant IDs come from the saved client link; active relationships and delegated access are checked before each operation, with no application-credential fallback. Writes require an Atlas administrator, recent authentication, Microsoft delegated license permission, and the partner user's GDAP role. Group-assigned licenses remain managed through Microsoft Entra.

## [1.7.34] - 2026-10-19

### Fixed

- **Microsoft 365 connection diagnostics.** Failed Graph reads now include recognized Microsoft error codes, a safe explanation, and a validated Microsoft request ID when available. Customer checks retain those details for troubleshooting without exposing raw response messages, tokens, client secrets, or authentication challenges.


## [1.7.33] - 2026-10-19

### Added

- **Microsoft 365 GDAP partner sign-in.** Connect a partner Microsoft account, discover active customer relationships, map customer tenants to Atlas clients, and sync documentation using delegated customer access. Partner refresh tokens are encrypted and renewed on use; disconnect cancels pending sign-ins and prevents delayed token refreshes from restoring access. Existing application-consent sync and Atlas staff sign-in remain available. See the [GDAP setup guide](docs/M365-GDAP.md).

- **Atlas for Windows 0.3.3: install updates from inside the app.** Check for updates, download the setup program, verify its checksum, and install and restart from the window or tray. (#202)
- **ScreenConnect connections in Atlas for Windows.** Open a linked ScreenConnect session from an asset. (#204)
- **Windows Hello and idle locking.** Require Windows Hello before revealing or copying passwords, and lock the app after inactivity. The same protection applies to earlier passwords and password attachment downloads. (#205)
- **More item details in Atlas for Windows.** View related items, download attachments, inspect earlier passwords, restore archived items, and see the time remaining on one-time codes. (#206)

### Fixed

- **Windows relaunch and refreshed lists.** Relaunching brings a hidden window back, and lists no longer keep stale rows after changes. (#203)

## [1.7.32] - 2026-10-15

### Changed

- **Atlas for Windows 0.3.2: Passwords, Assets, and Documents lists as tables.** Each row has a tile with an icon for what it is (a password's category, an asset's type), the favorite star, and chips such as 2FA, plus a line that tells it apart: username, site, and folder; type, IP, OS, and serial; or where a document lives. Columns show a password's strength as a four-bar meter, with breaches and reuse in red, or an asset's or document's status; what's coming due (rotation, expiry, warranty, review), amber within two weeks and red when overdue; and who changed it last and when. Everything shown comes from what Atlas already sends. (#200)

## [1.7.31] - 2026-10-15

### Fixed

- **Your theme applies on a first visit.** In a new browser or tab, Atlas often showed its default colours, title, and sizes instead of your theme, on the sign-in page and after signing in. The first "not signed in" answer was dropping the theme while it was still downloading. Public information (the theme, setup, and sign-in options) now stays when a session ends. (#198)

### Changed

- **Atlas for Windows 0.3.1: a Clients table.** Each client shows a coloured tile, its type, status, your access, maintenance window, when it last changed, and the first line of its quick note, with columns for how many passwords, assets, and documents it has and a badge for anything expiring or expired in the next 30 days. The page line totals everything, and the filter picks active clients, prospects, or inactive ones; inactive clients are now listed. (#197)

## [1.7.30] - 2026-10-15

### Changed

- **Atlas for Windows 0.3.0: a redesign that works like the web app.** The window now has a sidebar (Home, Clients, Passwords, Assets, Documents), a breadcrumb with Back (Alt+Left or Esc), and one page at a time. A client opens on an **Overview** with its quick note, key facts, contacts, and locations, and tabs for its passwords, assets, and documents. **Home** shows your favorites and what you opened recently, and every item has a star to add or remove it. (#193)

### Added

- **Editing in Atlas for Windows.** People who may change a client can now, from the app: add, edit, and archive **passwords** (with a generator, folders, and change reminders; saved secrets are never shown in the form); add, edit, and archive **assets**, with a form built from the asset's type; edit the client's **quick note**; add, edit, and delete **contacts** and **locations**; and write, edit, and archive **documents**. Documents are edited as text with the formatting typed in (headings, lists, checklists, quotes, code, bold, links), with a toolbar and a preview. A document with tables or centred text keeps its body as it is, and only its title and status change in the app. If someone else saved first, the app says so instead of overwriting their change. Editing needs a new sign-in: earlier sign-ins can only read. Tested in CI with the app's sample data, not yet against a real Atlas server. (#193)
- **Desktop app sessions can star items** with read access, and list your favorites. (#193)

## [1.7.29] - 2026-10-14

### Fixed

- **Remote access works after updating.** The update to 1.7.28 was installed by the previous release's installer, which didn't know about the new `atlas-access` script, so choosing Cloudflare Tunnel, Tailscale, or a reverse proxy failed with "atlas-access: No such file or directory". The server's helper now installs the script from the running release when it is missing. (#194)

## [1.7.28] - 2026-10-14

### Added

- **Remote access.** **Administration → Remote access** chooses how people reach Atlas: from this server directly, through a **Cloudflare Tunnel** (no inbound ports), through **Tailscale** (your tailnet, or the internet with Funnel, at the server's .ts.net name with a trusted certificate), or behind **your own reverse proxy** (nginx, Traefik, IIS, Nginx Proxy Manager). The server installs and runs cloudflared or Tailscale itself, and if Atlas doesn't answer at the new address it puts the previous settings back. Only the owner can change it, after confirming their password; the tunnel token and auth key are kept where only root can read them and are never logged. The installer takes the same choices (`--access`), and updates keep them. Tested in CI against real systemd with stand-ins for cloudflared and Tailscale, not yet against real accounts. (#191)
- **A full manual on the documentation site**, with 16 chapters, screenshots of the current look, search, and light and dark. (#190)

### Changed

- **Atlas trusts only its own web proxy about visitors' addresses.** The Linux installer now sets `TRUST_PROXY` to `127.0.0.1,::1` instead of trusting every proxy, and `TRUST_PROXY` accepts a list of addresses. (#191)

## [1.7.27] - 2026-10-14

### Added

- **Services page.** **Administration → Services** shows Atlas, the web proxy, the database, and the updater with whether each is running and since when. An administrator can restart one, or **Repair the installation**, which puts the installer's owners and permissions back, re-enables the services, restarts them, and waits for Atlas to answer. Every action asks for your password again and is written to the security log. Atlas still never runs as root: it asks the updater's helper, which accepts only these four actions by name. This is for servers set up with the Linux installer; Docker and Windows installs get a note on restarting their own way. Tested against real systemd in CI with stand-in services, not yet on a real Atlas server. (#186)
- **Certificate page.** **Administration → Certificate** shows the certificate Atlas is served with, checked the way a visitor's computer sees it: who issued it, the addresses it covers, when it runs out, and whether it is trusted. On an install at an IP address, where the portal uses its own certificate authority, the page offers that authority's certificate to download, with its thumbprint and the PowerShell commands to check and install it on a computer or through Group Policy. Install it only on computers you manage. Tested against a real Caddy in CI; importing the file into a Windows trust store has not been tried yet. (#187)
- **Menu styles.** Choose how Atlas's menu looks under **Menu** on your account page: **Rail and panel** (the new default: icons for Home, Clients, Docs, Vault and Admin, with that area's pages beside them), **Sidebar** (one list, with Administration as its own menu), or **Top bar**. It's saved for each person. (#188)

### Changed

- **A calmer look throughout.** A new typeface (Instrument Sans), neutral greys, flatter cards without shadows or dividers under their titles, statuses as a small dot and a word instead of coloured pills, and fewer coloured icons. Client overviews are laid out in even rows. (#188)
- **The dashboard heading is "Overview"**, with today's date, instead of a greeting. (#188)
- **Detail pages share one header.** Assets, passwords, documents and checklist runs show what the record is, its name with the star beside it, one line of status and history, and the actions on the right. (#188)
- **Long settings pages list their sections** down the left, marking the one you're reading: Import & export, Vault policies, Password rotation, and the new settings pages. (#188)
- **Settings is split into separate pages** in a Settings group of the Admin menu: **Email & alerts**, **Monitoring** (RMM health, warranties, asset statistics, domain and SSL trackers), **Sign-in** (Microsoft and SAML), **API keys**, and **Theme**. Old links to Settings open Email & alerts. **Erase all data** has moved to the bottom of **Import & export**. (#188)
- **Activity feeds group repeats.** Several changes in a row by the same person to the same kind of thing show as one line ending "and N more". (#188)
- **Dialogs** have no grey footer band, and the screen behind them dims to a neutral grey. (#188)
- **The installer raises the updater's start limit** (20 starts a minute), so a burst of actions can't stop it. An existing server gets this the next time the installer runs there, which is the update after this one; until then Atlas spaces service actions five seconds apart. (#186)

## [1.7.26] - 2026-10-13

### Added

- **Atlas for Windows has a setup program.** `AtlasForWindowsSetup.exe` is attached to every release from this one on, and staff can download it from **Desktop apps** on their account page. It installs for the person running it, without administrator rights and with nothing else to install first. Running a newer one upgrades in place and keeps you signed in; uninstalling removes the app, its Start with Windows setting, and its saved session. It isn't code-signed, so Windows SmartScreen asks before running it (More info, then Run anyway). Every build now starts the app, installs it, upgrades it over a running copy, and uninstalls it on a clean machine, but nobody has used it day to day yet. (#184)
- **Update notice in Atlas for Windows.** The app has its own version number (0.2.0), which changes when the app does. When the Atlas it is signed in to offers a newer one, it says so once and adds **Get version …** to its tray menu, which opens the download in your browser. It never downloads or installs anything itself. (#184)

### Changed

- **Atlas for Windows: Start with Windows works for the installed app.** It was only available to an MSIX package before. (#184)
- **Atlas for Windows: a clearer message when the certificate isn't trusted.** If the computer doesn't trust your Atlas's certificate, the app says so instead of saying Atlas could not be reached. It still has no way to accept an untrusted certificate. (#184)

## [1.7.25] - 2026-10-12

### Added

- **Move a personal entry to a client.** Open an entry in My vault and choose **Move to a client** for a login that turns out to belong to the team. Pick a client you have password access to, and a folder if you like. It becomes one of that client's passwords, visible to everyone with password access there and audited from then on, and it leaves your vault. It can't be moved back. (#182)
- **Export your personal vault.** **Export** on My vault downloads everything in it as a CSV file in the layout Bitwarden uses. Atlas asks for your password first, and the security log records that you exported, not what was in the file. The file holds every password in plain text. Importing it into another password manager has not been tested yet. (#182)

### Changed

- **Dialogs on phones.** A dialog's buttons now wrap onto a second line instead of running off a narrow screen. (#182)

## [1.7.24] - 2026-10-08

Version 1.7.23 was never published: its build failed, and this release carries everything meant for it.

### Added

- **Personal vaults.** **My vault**, under Passwords, gives each staff member a private place for their own logins and secure notes. Only the person who made an entry can open it: there is no administrator view, no emergency access, and no API-key access, and entries stay out of search, reports, password health, exports, and the audit log. The browser extension offers your own logins on matching sites, marked "My vault". Deleting an entry is permanent. The owner can turn personal vaults off in Vault policies, which hides them without deleting anything. (#178)
- **SAML single sign-on.** Administration → SAML sign-in connects Atlas to any SAML 2.0 identity provider (Okta, Entra ID, Google Workspace, JumpCloud, and others). People are matched to accounts you've already created, and an administrator confirms each link before it works. Not yet tested against a real identity provider: try it with one account first, and keep a password sign-in for the owner. (#174)
- **Webhooks.** Administration → Webhooks sends a signed message to an address of yours when something changes in Atlas, by topic (clients, assets, documents, passwords, and more). A failed delivery is retried five times over several hours, each webhook shows its recent deliveries, and one that keeps failing is paused. Messages never contain secrets. (#176)
- **Share a document by link.** **Share** on a document makes a link that anyone can open without signing in, for how-to articles you send to a client's staff. Links can expire, show how often they've been opened, and can be revoked. The reader sees that one document only. (#177)
- **QR labels for assets.** **QR label** on an asset, or **QR labels** on a client's Assets tab, prints labels in three sizes. Scanning one opens the asset in Atlas, after signing in. (#175)

### Changed

- **README.** Brought up to date with everything shipped since 1.0. (#173)

## [1.7.22] - 2026-10-06

### Added

- **BitLocker collector.** Administration → BitLocker collector makes an enrollment for a client (for all of its devices, or one) and downloads a PowerShell script for your RMM to run as SYSTEM. The script reads each volume's BitLocker status and recovery passwords, encrypts the passwords on the machine, and uploads the report; it only reads, runs on Windows PowerShell 5.1 and later, and queues reports when Atlas can't be reached. Recovery keys are saved to the client's vault, once each, linked to the machine's asset (matched by serial number, then name), and each asset gets a BitLocker panel showing every volume's protection. Enrollments can be revoked and single machines blocked. Not yet run on real hardware: pilot it on one machine first. See docs/BITLOCKER.md. (#171)

## [1.7.21] - 2026-10-06

### Added

- **BitLocker recovery keys from ConnectWise RMM.** A new BitLocker keys option on the ConnectWise RMM sync (off by default) reads each synced device's custom fields and saves any recovery key it finds to the client's vault, linked to the device. Keys are recognized by their shape, so the custom field can have any name and hold several drives' keys with their IDs. Each key is saved once; when a device gets a new key, the old entry is kept. (#169)

### Changed

- **Recovery keys stay out of asset fields.** The ConnectWise RMM device sync no longer copies a value containing a BitLocker recovery key into an asset field. With the BitLocker keys option on, a key already in a synced asset's fields is moved to the vault (earlier versions of the asset still show it in history). (#169)

## [1.7.20] - 2026-10-01

### Added

- **Checklist and runbook templates.** A Template library button on Checklists and the MSP knowledge base offers 13 ready-made checklists (client and user onboarding and offboarding, endpoint setup and decommission, server patching, backup verification, Microsoft 365 setup, firewall change, password rotation, incident response, SSL and domain renewal) and 6 runbooks, which go in a Runbooks folder. Added templates are ordinary checklists and documents to edit and run, and adding again never duplicates one.

## [1.7.19] - 2026-10-01

### Added

- **Delete a client.** Administrators see a Delete button on the client page. Typing the client's name exactly deletes the client and everything in it, and the deletion shows in the security log.

### Changed

- **Sidebar sections.** Dashboard, Clients and Expirations stay pinned at the top, and everything else sits in collapsible sections (Documentation, Passwords, and for admins People & security, Data, and System). A collapsed section is remembered per browser.

## [1.7.18] - 2026-10-01

### Added

- **Hudu processes, networks and relations import.** Processes become checklists, networks become Networks assets, and Hudu relations become Atlas links. Two new import choices, Processes and Networks, are on by default.
- **ConnectWise expiry tickets (opt-in).** Each sync can open one ConnectWise ticket for every domain, certificate, license or warranty date coming due within a set number of days (30 by default), through the v2 platform ticket API.
- **Monthly client report.** Each client has a printable Monthly report page, linked from the client header, that the browser can save as a PDF.
- **Windows preview download.** CI builds a downloadable Atlas for Windows preview.

### Changed

- The ConnectWise RMM code is split into separate files for the API client, device records and the sync. No behavior change.

## [1.7.17] - 2026-09-30

### Fixed

- **Tickets show the portal's 4-digit ticket number, never ConnectWise's long alert ID.** A ticket the platform opened itself gets its portal number from ConnectWise's CW-System note, read through the ticket notes API as the notes panel is.
- **Atlas links are written through the v2 API only.** The device "Atlas link" custom field is found through v2, so the v1 custom field definitions that refused the key are no longer called. Companies have no v2 custom field API, so company links are no longer written. Add a text custom field named "Atlas link" for devices in ConnectWise if there isn't one.

## [1.7.16] - 2026-09-30

### Changed

- **The ConnectWise ticket sync uses only the v2 platform ticket API.** The legacy v1 company, status and ticket note lookups (PSA) are gone from the sync. Tickets link by the platform company ID, and a company's record number no longer takes priority over its sites.

## [1.7.15] - 2026-09-30

### Fixed

- **Every ConnectWise company's tickets get links.** A company ConnectWise gives no company number is linked by its platform company ID, the same ID the RMM device sync uses.

## [1.7.14] - 2026-09-30

### Fixed

- **Ticket links for companies whose records carry no IDs.** A company ConnectWise lists without IDs is linked by the company IDs its sites carry, and when those are missing too the sync log shows which fields ConnectWise did return.

## [1.7.13] - 2026-09-30

### Fixed

- **More ConnectWise companies get ticket links.** A company whose number isn't in ConnectWise's company list is looked up on its own record, and the sync log shows the IDs ConnectWise gave any company still without a link.

## [1.7.12] - 2026-09-30

### Fixed

- **Clearer ticket link warnings, and more companies linked.** The sync log names companies by their Atlas client name and says whether a missing link is the company's number or an automation ticket still waiting on its portal ID. A ConnectWise company with numeric IDs from several products now links by the one from the product most companies' IDs come from.

## [1.7.11] - 2026-09-30

### Fixed

- **Automation tickets show their ConnectWise portal ID.** Tickets the platform opened itself carry a dotted number (such as 133023.1670) the portal can't find. Atlas now reads the CW-System note that names the portal's copy ("Connectwise ticket id 5283 is created to match ...") and shows and links that ID instead.

## [1.7.10] - 2026-09-30

### Fixed

- **One Endpoints layout, no duplicate machines.** Hudu imports and ConnectWise RMM syncs fold leftover Devices, Computer Assets and similar layouts into Endpoints. A machine with the same name in the same client is merged into one asset, the rest move over with their values as a new version, and the emptied layout is archived. (#143)

## [1.7.9] - 2026-09-30

### Fixed

- **ConnectWise ticket numbers and links match the portal.** Tickets show the plain ticket ID the ConnectWise portal uses (such as 5535) instead of the platform's dotted number, and the ticket link opens through the portal's service tickets page, as the portal's own links do.

## [1.7.8] - 2026-09-30

### Added

- **Ticket board, source, and type.** Each ticket shows its ConnectWise service board, source, and type under the summary, and the sync log names any company whose tickets can't be linked. (#138)

### Fixed

- **Every ticket links to ConnectWise.** Alert tickets numbered with a dot (such as 133023.1533) now get a link, and both the number and the summary open the ticket. (#138)
- **Product site:** the ConnectWise features shipped in 1.7.7 move from the roadmap to New in 1.7. (#137)

## [1.7.7] - 2026-09-30

### Added

- **Security and compliance from ConnectWise.** Clients linked to a ConnectWise company get a Security and compliance card with Windows and third-party patch compliance, backup and DR readiness, vulnerabilities by severity, and open MDR cases; synced devices get their own card with missing patches, backup jobs, and CVEs. Areas a partner doesn't use show "Not available". (#130)
- **ConnectWise contacts and a live device panel.** Each linked company's contacts sync into the client (matched by email), and a synced device's page shows disk space with a low-disk flag, CPU and memory use over the last day, device groups, and effective policies. (#131)
- **Write back to ConnectWise (off by default).** Atlas links can be written into an "Atlas link" custom field on devices and companies, and techs can read and add internal ticket notes; a password revealed with a ticket number in the reason adds a note to that ticket, without the password. (#132)
- **Installed software, sign-ins, and VM hosts.** Synced devices list their software and the accounts that sign in, the client overview gets a Software card that flags out-of-support, unlicensed, and over-seat apps, and devices link to their user's contact and to their VM host. (#133)
- **Hudu import shares an Endpoints layout with RMM devices**, so machines are no longer imported twice, and Hudu websites become Domains assets for the domain tracker. (#134)

### Fixed

- **Asset links and reloads** open the asset page instead of showing a raw "Not found" error. (#135)
- **The client overview fits a phone screen.** (#135)

## [1.7.6] - 2026-09-30

### Fixed

- **ConnectWise RMM devices get their manufacturer and endpoint protection.** Device details now ask ConnectWise for the hardware and antivirus sections, which it leaves out unless they are named, so Manufacturer and protection status fill in on the next sync. (#127)
- **Closed ConnectWise tickets are listed again.** The closed-ticket filter now uses the format ConnectWise expects, so closed counts are no longer missing. (#127)
- **Password rotation starts its script through ConnectWise's task scheduling call**, as the platform API defines it. (#127)

## [1.7.5] - 2026-09-30

### Fixed

- **ConnectWise RMM sync fills the right device fields.** The manufacturer now comes from the device's baseboard maker (Dell, Lenovo, HP) and goes into the Manufacturer field, instead of the BIOS vendor or an extra field. Last check-in comes from ConnectWise's heartbeat, and endpoint protection from the device's antivirus list and antivirus services, so both now show on assets and the RMM health charts. The device list follows ConnectWise's paging, asks 500 devices at a time, and reads each device from its own site. Field names follow ConnectWise's published platform API spec. (#124)

## [1.7.4] - 2026-09-30

### Added

- **Warranty lookup by serial number.** Dell, Lenovo and HP devices get their warranty end date from the vendor's public warranty check, with no API keys to set up. It is looked up when a device with a serial number and no warranty date is saved, and during the ConnectWise RMM sync for devices the RMM gives no date for. A date someone typed in is never replaced. Each asset has a **Check warranty** button that looks it up right away, and Settings, Asset warranty can turn automatic lookups off. (#122)

## [1.7.3] - 2026-09-30

### Fixed

- **Hudu imports no longer duplicate clients.** A Hudu company imported for the first time now links to the Atlas client with the same name (ignoring case, spacing and punctuation) and updates it, instead of adding a second client. Clients added by hand or from ConnectWise RMM are matched this way. Duplicates made by earlier imports can be merged on the Duplicates page. (#118)

## [1.7.2] - 2026-09-30

### Fixed

- **ConnectWise tickets now sync.** The ticket dashboard asked for tickets at addresses the ConnectWise platform doesn't have, so every sync reported "No tickets listed". It now reads the platform's service ticketing API (`/api/platform/v2/service/ticketing/tickets`), tells closed tickets apart by the status's Closed category, and links each ticket to its page in the ConnectWise web app (North America; the company needs its numeric company ID mapped). (#98)
- **ConnectWise RMM devices show whether they're online.** Device records don't carry it, so every device counted as online unknown. The sync now reads each company's agent availability from the platform heartbeat API (`/api/platform/v2/device/endpoints/heartbeat`).

## [1.7.1] - 2026-09-30

### Fixed

- **ConnectWise RMM devices are saved as device assets, not Configurations.** The sync saves new devices in a layout named Devices or Device assets when there is one (or the layout chosen under *Save devices in*), updates same-named assets already in it instead of adding copies, and moves devices an earlier sync put in Configurations (or in a layout chosen before) there, keeping what was entered on them. Restoring a version from before the move puts the asset back in its old layout. Only assets the sync made are archived when their device goes away. Configurations is still used when there is no device layout.

## [1.7.0] - 2026-09-30

### Added

- **Atlas for Windows (preview):** a tray app for technicians. Ctrl+Shift+Space opens quick search over the clients, assets, documents, and passwords you can see; copy a username, password, or one-time code (recorded like a reveal, and cleared from the clipboard after 30 seconds, never kept in clipboard history), open the sign-in address, or open the record in Atlas. It signs in through your browser with your usual password and second step or passkey, keeps only a DPAPI-protected session token, and can start with Windows and remind you about items expiring in the next 14 days. Signed MSIX packages and automatic updates come next. (#23)
- **Desktop app sign-in:** the authorization code flow with PKCE and a loopback redirect, issuing app sessions with `read`, `write`, and `reveal` scopes. Signed-in apps are listed on the Account page, where they can be signed out, and end with every other kind of sign-out. (#23)
- **Quick search API:** `GET /api/v1/search` takes a `limit`, for as-you-type use. (#23)
- **Vault policies:** a new Administration → Vault policies page. It shows that MFA is required for staff and lists anyone who can reach passwords without it. The owner can set the password generator's minimum length and required numbers or symbols (and turn off PINs), require a reason for every reveal in every client, stop read-only accounts from revealing passwords, and make restricted passwords available only to the people listed on them, administrators included. (#35)
- **Emergency access:** the owner names trusted administrators, each with a waiting period. A trusted administrator can request access to every restricted password; the owner is emailed at once and can deny it during the wait or approve it sooner. Access lasts 24 hours, every step is in the security log, and each password used is marked "Emergency access" in its access history. (#35)
- **SIEM streaming:** send the security log and the password access log to a SIEM as they happen, by HTTPS webhook (JSON, optionally HMAC-signed) or syslog (RFC 5424 over TLS, TCP, or UDP). Failed sends are retried from where they stopped. (#35)
- **Browser extension for Edge and Chrome:** suggests the logins saved for the site you're on and fills them, with a quick search to copy a password, username, or one-time code for any login you can use. It signs in through Atlas: you approve the browser in Atlas after checking a code, and the extension gets a session tied to a key that never leaves the browser. It stores no passwords and asks Atlas each time. Fills and copies are recorded like reveals, and clients that require a reason ask for one. Signed-in browsers are listed on your account page, end after 7 days unused or 30 days in total, and are signed out with everything else when your password changes or an administrator signs you out. Build it with `npm run build:extension`. (#28)
- **Asset statistics:** a card on the dashboard and each client's overview with servers, workstations, switches, network devices, printers, and phones, and a chart of operating systems that marks the ones out of support. Choosing a tile or slice lists the devices, and administrators choose how each layout counts under Settings → Asset statistics. (#106)
- **Tickets from the ConnectWise platform:** a Tickets card with tickets opened and closed per day and a tile per status, plus a Ticket details table on each client's overview. Tickets are read from the ConnectWise platform API with the existing connection and company links; turn on Tickets under *What to sync*. (#107)
- **Domain and SSL trackers:** domains are re-checked with their registry and certificates are read from each site on a schedule, and the dates are saved on the asset so Expirations and its alerts pick them up. A Domain and SSL expiry card shows what is expired or expiring, and each client has Domain Tracker and SSL Tracker tabs with Check now. (#108)
- **Automated password rotation:** Administration → Password rotation changes local administrator and Active Directory service account passwords on a schedule through ConnectWise RMM. The vault changes only after the device confirms the new password; failures keep the old one and alert administrators. (#109)
- **Customizable dashboard:** star clients, documents, and assets for a Favorites card, and show, hide, and reorder dashboard cards. Client quick notes sit at the top of every client page with history, compare, and restore; client tabs show counts and can be hidden; and the overview shows primary contact, phone, hours, and maintenance window. (#111)
- **Secure notes, files, and Send:** the vault holds secure notes as well as logins, encrypted files can be attached to any entry, and Send shares text or a file once through a link whose key never reaches the server. (#114)

### Fixed

- **Passwords:** changing only some details of a password (for example a bulk rotation change, or restricting it) no longer clears its website address. (#28)
- **Browser extension:** it now follows the vault policies: restricted logins stay hidden from administrators when restricted passwords are for listed people only, and read-only accounts can't fill passwords or open files on entries when reveals are blocked. (#110, #112, #114)

## [1.6.0] - 2026-09-29

### Added

- **Microsoft 365 sync:** document each client's tenant from one multi-tenant app registration (Directory.Read.All, admin consent per tenant). Users become contacts (with their licenses and admin roles), paid subscriptions become License assets with seats bought and assigned, custom domains become Domain assets, and a Microsoft 365 asset lists the tenant's domains, subscriptions, and administrators. Runs every six hours or on demand; cancelled subscriptions and removed domains are archived. Set up under Administration → Import & export. (#103)
- **Runnable checklists:** reusable checklists for all clients or one, run step by step for a client with who ticked each step and when, notes, an assignee, and a due date. New Checklists page and client tab; runs export to Markdown or print to PDF. (#101)
- **Relationship map:** a Map tab on each client showing how its assets, passwords, documents, contacts, and locations link together, with the same links as a list. (#100)
- **Manufacturer detection:** a blank Manufacturer is filled in from the model (OptiPlex → Dell, ThinkPad → Lenovo), operating system, device name, or MAC address whenever a device is saved or synced; entered values are never replaced. ConnectWise RMM firmware names are tidied ("Dell Inc." → Dell). A Fill in manufacturers button handles existing assets. (#104)

## [1.5.3] - 2026-09-29

### Fixed

- **People & access:** the Manage dialog now offers Confirm Microsoft account (and Unlink Microsoft) on your own row, so an owner with no other administrator can link their own Microsoft account. (#92)

## [1.5.2] - 2026-09-29

### Fixed

- **Sign in with Microsoft:** the page Atlas redirects to after returning from Microsoft no longer fails with "Cross-site requests are not allowed."; cross-site requests are still refused for API paths. (#90)

## [1.5.1] - 2026-09-29

### Fixed

- **Sign in with Microsoft:** returning from Microsoft no longer fails with "Cross-site requests are not allowed."; passkey sign-in now respects "Require Microsoft sign-in" for staff; and confirming a Microsoft link now shows the account's name, email and ID and approves exactly that account. (#87)

## [1.5.0] - 2026-09-29

### Added

- **Sign in with Microsoft Entra ID:** staff can sign in with their Microsoft 365 account (OpenID Connect with PKCE, state, and nonce; the sign-in token is checked in full). Accounts are never created by signing in: a Microsoft account must match an existing Atlas user, by account ID once linked, and the first match by email waits for an administrator to confirm it under People & access. An option trusts Microsoft's own multi-factor sign-in; another requires Microsoft sign-in for staff while the owner can always still use a password. Set up under Settings → Microsoft sign-in. (#85)

### Changed

- New and changed passwords are breach-checked within about ten minutes, not at the next daily run. (#83)
- A sign-in with a step still to finish (Atlas MFA, MFA setup, or a password change) can now be reloaded without an error.

## [1.4.0] - 2026-09-29

### Added

- **Password health:** a report of weak, reused, overdue, expired, old, and breached passwords across the clients you can open, with a score per client, filters, a CSV export, and a health tile on the dashboard. Breached passwords are found with Have I Been Pwned's k-anonymity check: only the first 5 characters of a scrambled fingerprint leave the server, and only a count is stored. New and changed passwords are checked within about ten minutes, older results are re-checked daily; an administrator can run them now or turn them off for servers without internet access. (#81)

## [1.3.2] - 2026-09-29

### Fixed

- **ConnectWise RMM sync:** a device no longer fails with "Choose a listed option for Type". Extra values go only into fields that can hold them (a choice list takes one of its options), and the named mapping wins over them. (#79)

## [1.3.1] - 2026-09-29

### Changed

- **ConnectWise RMM sync imports every field:** besides hostname, IP, MAC, and the other named fields, every other value ConnectWise sends about a device (IDs, types, agent details, tags, nested details) goes into a field on the asset, matching existing fields by label and adding the ones the layout lacks. (#77)

## [1.3.0] - 2026-09-26

### Added

- **Duplicates:** Administration → Duplicates lists assets, contacts, and locations with the same name in the same client, and clients with the same name. Choose the record to keep and merge the rest into it: blank fields are filled, values without a field get a new field, links, files, and Hudu/ConnectWise RMM IDs move over, and merged assets are archived so they can be restored. Merging clients moves everything in them. (#75)

## [1.2.0] - 2026-09-26

### Added

- **Choose what gets imported:** the Hudu import lets an administrator tick which kinds of data to bring in (clients, locations, assets, documents, passwords), which companies, and which asset layouts. The choices are saved for the next run. ConnectWise RMM sync can be limited to sites or devices, and scheduled syncs follow the choice; with devices off, no device is ever archived. (#72)
- **Erase all data (owner only):** Settings → Danger zone. Requesting it needs the owner's password, a fresh authenticator code, and the organization's name typed exactly. A 10-minute wait follows, during which every administrator is emailed and any of them can cancel. The owner then confirms again, and a full backup is taken before anything is erased (nothing is erased if the backup fails). People, settings, integrations, backups, and the security log are kept. (#73)

### Fixed

- Red (danger) buttons have readable text in dark mode. (#73)

## [1.1.11] - 2026-09-26

### Fixed

- **Imports after a restart:** an import or ConnectWise RMM sync cut off by a restart (for example installing an update) is marked stopped when Atlas starts again, so a new one can start straight away instead of being refused for five minutes. (#70)

## [1.1.10] - 2026-09-26

### Fixed

- **ConnectWise RMM sync:** the note about archived duplicate copies says "copies" instead of "copyies". (#68)

## [1.1.9] - 2026-09-26

### Changed

- **Imports put every value in a field:** the Hudu import matches integration data (Atera, ConnectWise Manage, NinjaOne, and others) and extra Hudu fields to the fields they mean, and adds a field to the layout for anything it has no field for, instead of writing device details into the notes. Re-running the import moves details out of existing assets' notes and keeps fields added since. The ConnectWise RMM sync likewise adds fields to a matched asset's layout when needed. Asset layouts can now have up to 200 fields. (#66)

## [1.1.8] - 2026-09-26

### Added

- **Check Microsoft 365 permissions:** Settings → Email has a Check permissions button that signs in to Microsoft and shows whether the app registration has the Mail.Send application permission, without sending an email. (#64)

### Changed

- **ConnectWise RMM sync updates what is already there:** a device that matches an existing asset by name or hostname (for example one imported from Hudu) updates that asset, in whichever of its fields fit, instead of creating a Configurations copy. Copies made by earlier syncs are archived and their devices moved to the existing asset. (#63)

## [1.1.7] - 2026-09-26

### Fixed

- **ConnectWise RMM sync:** devices now get their hostname, IP address, and MAC address from ConnectWise's device details, including at companies with more than one site. (#61)

## [1.1.6] - 2026-09-26

### Fixed

- **ConnectWise RMM sync:** synced devices now get their hostname, operating system, IP and MAC address, manufacturer, model, and serial number, read from each device's details in ConnectWise. Each sync notes one device's field names (never values) to help finish the mapping. (#59)

## [1.1.5] - 2026-09-26

### Fixed

- **ConnectWise RMM sync:** devices are read from every category in ConnectWise's response (platform, network, and others) and from records that hold their own device list, with more device ID names recognised. If records still lack an ID, the job note names their fields (never values). (#57)

## [1.1.4] - 2026-09-26

### Fixed

- **Microsoft 365 email:** when Microsoft refuses to send, Atlas now checks its own token and says whether the app is missing the Mail.Send *Application* permission (Delegated permissions don't work for Atlas) or is being kept from the mailbox by an Exchange access policy. A permission fixed in Entra applies on the next try instead of up to an hour later. (#56)
- **ConnectWise RMM sync:** a company with no devices (ConnectWise's "resource not found") no longer fails the sync; device lists nested deeper in ConnectWise's response are found; devices are no longer dropped when their own client ID uses a different numbering; and a company that still comes back empty gets a job note with the response's field names (never values). (#54)

## [1.1.3] - 2026-09-26

### Fixed

- **ConnectWise RMM sync:** devices are requested with the resource types ConnectWise accepts (client, company, site, then every device the key can see, filtered to the company), after a real tenant rejected the plural forms. If no request works, the sync message still shows every attempt's answer without cutting any off. (#52)

## [1.1.2] - 2026-09-26

### Fixed

- **ConnectWise RMM sync:** when devices can't be listed, the sync message shows ConnectWise's answer to every request Atlas tried and points at the API key's Devices read permission. Import messages are no longer cut off at 300 characters. (#49)

## [1.1.1] - 2026-09-26

### Fixed

- **ConnectWise RMM sync:** no longer gets the API key locked (423) by signing in on every request; one sign-in is shared and ConnectWise's slow-down responses are retried. Device lists that ConnectWise rejected (400) now try the other request formats ConnectWise uses and keep the one your tenant accepts, and sync errors include ConnectWise's own explanation. (#47)

## [1.1.0] - 2026-09-26

### Added

- **ConnectWise RMM (Asio) sync:** Import & export connects ConnectWise RMM with an API client ID and secret, links RMM companies to Atlas clients (same-name clients suggested), and syncs hourly or on demand: sites become locations, devices become Configurations assets, and devices the RMM stops reporting are archived. Still to be confirmed against a live ConnectWise tenant. (#44)
- **Sidebar client picker:** jump to any client from the sidebar. (#24)
- **Quick share:** create a one-time share link for a password straight from the list, for clients without a portal login. (#25)
- **Password list sort and grouping:** sort by name, client, type, recently changed, or needs attention; group by client or type. Remembered per browser. (#36)
- **Password folders:** per-client folders, a folder filter in the list, and a Folder field in the form. Hudu imports keep their password folders. (#37)
- **Favorites and recently used:** star passwords (personal to you) and show only favorites or the ones you last used. (#38)
- **Bulk actions:** select passwords to archive or restore them, or change rotation, client-portal sharing, or type in one go. Each is checked and audited individually. (#39)
- **Link assets from the password form.** (#40)
- **Custom fields on passwords:** up to 30 labelled values each, optionally hidden (encrypted, revealed and audited per field). Included in decrypted exports. (#41)
- **Generator presets:** Strong, Admin / service account, Easy to type, Wi-Fi / spoken, and a new PIN mode; the last settings are remembered per browser. (#42)
- **Password expiry dates:** an optional date the account stops working, shown on the password and on the Expirations page and in expiry emails. (#43)

### Fixed

- **Microsoft 365 email:** a failed test email is now logged with Microsoft's reason, and common Entra sign-in errors (secret ID instead of value, expired secret, wrong IDs, missing consent) say what to change. (#45)
- **API keys:** password folder routes now need the passwords scope. (#37)

## [1.0.3] - 2026-09-25

### Added

- **Theme manager:** Administration → Theme sets your brand name, tagline, browser title, favicon, and light and dark logos; accent and sidebar colours (with separate dark-mode colours, automatic text contrast, and readability checks before saving); text size, density, corners, sidebar width, navigation highlight style, and animations; and the sign-in page's headline, text, and background image. Changes preview live across Atlas until you save. It replaces the Branding card in Settings. (#21)

## [1.0.2] - 2026-09-25

### Added

- **Linux installer:** `deploy/linux/install-atlas.sh` installs Atlas on Ubuntu 22.04/24.04 or Debian 12 without Docker (Node.js 22, PostgreSQL 16, Caddy for HTTPS, a hardened systemd service, nightly backups). One script for every release: it installs the newest release by default, and re-running it upgrades. (#10, #19)
- **Updates:** Administration → Updates lists newer releases with their notes. On servers installed with the Linux script, an administrator can install one from there: a root-owned updater backs up, installs, and rolls back on failure. (#11)
- **Microsoft 365 email with an app registration:** sends through Microsoft Graph with OAuth2 (Mail.Send), replacing SMTP sign-in, which Microsoft is retiring for Exchange Online. System status warns while Microsoft 365 SMTP is still in use. (#16)
- **Domains assets fill themselves in:** saving a Domains asset looks up its registrar, expiry, name servers, and DNS host (RDAP and DNS), filling only blank fields. A "Refresh from domain" button re-checks. (#12)
- **Password types:** each login has a type (Domain, Microsoft 365, firewall, Wi-Fi, server, and more), guessed from its name, username, and address until you choose one. The list shows the type, the sign-in host, and linked assets, and can be filtered by type. (#15)
- **Quick actions:** copy the username, password, or current one-time code, or open the sign-in address, straight from the password list. (#17)

### Fixed

- **Hudu import:** assets now bring over their details, including data synced by integrations (RMM, PSA, Microsoft 365), fields with differently written labels, and People email addresses, not just their names. Passwords get the address saved in Hudu instead of Hudu's own link to the password, and keep their folder as a type and their link to the asset. (#14, #15, #18)
- **Key rotation:** `rewrap-keys` now also re-encrypts the SMTP password and Hudu API key (and the new Microsoft 365 client secret). (#16)

## [1.0.1] - 2026-09-24

### Added

- **Product site:** an overview, install guide, security model, and troubleshooting page at <https://ithealthtech.github.io/nexus-atlas/>.
- **Contributing guide:** setup, checks, the rules for code on the request path, and how to release.
- **Releases:** the Release workflow can be run from the Actions tab on `main`, and creates the version tag itself.

### Fixed

- **System status:** the "Backups are current" check said when the last backup finished as a raw timestamp (`2026-09-24T13:19:25.847Z`). It now says how long ago, for example "The last backup finished 9 hours ago."

## [1.0.0] - 2026-09-24

### Added

- **Clients and documentation:**
  - Client workspaces with assets, documents, contacts, locations, and activity.
  - 13 built-in asset layouts, plus your own layouts with 11 validated field types.
  - Per-client and internal MSP knowledge bases with a rich-text editor, templates, folders, and review dates.
- **History and search:**
  - Version history with line-by-line comparison and restore, and protection against overwriting someone else's edit.
  - Relationships between any items, and safe file attachments.
  - Full-text search with Ctrl+K, including by IP address and serial number.
- **Password vault:**
  - Envelope encryption with a data key per organization, protected by a master key that is never stored in the database.
  - Logins with live one-time codes, and BitLocker recovery keys.
  - A generator, strength and reuse warnings, rotation reminders, and previous passwords.
  - Entries restricted to named people or groups, optional reasons for reveals, and an access history.
  - One-time share links encrypted in the browser.
- **Accounts:**
  - Six roles, per-client access levels, and groups.
  - Authenticator apps, passkeys, recovery codes, and remembered browsers.
  - Session management with remote sign-out, and a password re-check before sensitive actions.
- **Email:** SMTP with a Microsoft 365 preset, password reset by email, expiry alerts, and a weekly digest.
- **Data in and out:**
  - A REST API with scoped API keys and an OpenAPI description.
  - Hudu import that updates rather than duplicates on re-runs, and CSV import with a dry run.
  - Per-client zip exports, and migration from the 0.2 prototype.
- **Branding and client portal:** your logo, accent colour, and a welcome message; client accounts get read-only access to their documentation and to passwords shared with them.
- **Backups:**
  - Encrypted nightly backups with retention, plus one-click and command-line backups.
  - Verified restore, including backups from older versions.
- **Hosting:**
  - A system status page with plain-language health checks.
  - A Windows service installer, and Docker Compose with automatic HTTPS.
  - A release workflow that publishes the Docker image and a Windows package for each version tag.
- **Guides:** administrator and user guides, and a deployment guide.

### Security

- **Browser requests:** Host, Origin, `Sec-Fetch-Site`, and CSRF checks on every request; a strict Content Security Policy with no inline or third-party scripts; `__Host-` `SameSite=Strict` session cookies.
- **Sign-in protection:** scrypt password hashes, lockout, rate limits, and single-use one-time codes.
- **Audit trail:** a tamper-evident security log, hash-chained by database triggers, with a signed checkpoint.
- **API keys:** stored as hashes, limited to their scopes and to documentation and vault endpoints. They are redacted from logs, and tested against URL-encoding and dot-segment tricks.
- **Encryption at rest:** encrypted backup files, with authenticated chunks, detection of cut-off files, and a restore that checks the whole file before changing anything.
- **Uploads:** stored outside the web root, with inline display only for images that pass a content check, and a sandboxing CSP on downloads.

### Known boundaries

- **Administrators can read every password.** Atlas is not end-to-end encrypted. Reads are recorded instead.
- **Rate limiting:** failed-attempt limits are held in each server's memory. Account lockout is stored in the database.
- **Hudu importer:** it connects to any `https://` address an administrator enters, including internal ones.
- **Not in 1.0:** single sign-on, PSA and RMM integrations, a browser extension, and IT Glue or ITBoost importers.
- **Windows installer:** checked in CI, but not yet run on a production Windows Server.
