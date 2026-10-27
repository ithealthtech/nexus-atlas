import type { RunbookBlock } from './templates.js';

// ---------- built-in guides: how-tos for using Atlas, written for each kind of person who signs in ----------
// Adding them puts them in an "Atlas guides" folder in the knowledge base, where they're edited like any document.
// Client accounts never see the knowledge base, so client guides are meant to be shared with a client's staff by
// link, or copied into the client's own Documents tab.

export const GUIDE_AUDIENCES = ['technician', 'client', 'admin'] as const;
export type GuideAudience = (typeof GUIDE_AUDIENCES)[number];
export const GUIDE_AUDIENCE_LABELS: Record<GuideAudience, string> = {
  technician: 'Technician',
  client: 'Client',
  admin: 'Admin',
};

export interface GuideTemplate {
  key: string;
  audience: GuideAudience;
  /** The document's title, without the audience; the copy is titled "Technician: …" and so on. */
  title: string;
  description: string;
  body: RunbookBlock[];
}

/** The title a guide's copy gets, so the folder sorts by audience. */
export const guideTitle = (t: Pick<GuideTemplate, 'audience' | 'title'>) =>
  `${GUIDE_AUDIENCE_LABELS[t.audience]}: ${t.title}`;

export const GUIDE_TEMPLATES: GuideTemplate[] = [
  // ---------- technicians ----------
  {
    key: 'guide-tech-first-day',
    audience: 'technician',
    title: 'Your first day in Atlas',
    description: 'Signing in, two-step verification, finding your way around and what your access means.',
    body: [
      {
        p: 'Atlas is where we keep everything we know about each client: devices, procedures, contacts, locations and passwords. If it isn’t in Atlas, the next technician won’t find it. This guide gets you signed in and comfortable in about ten minutes.',
      },
      { h: 'Sign in for the first time' },
      {
        ol: [
          'Open the Atlas address from your welcome email and sign in with your email and the temporary password.',
          'Choose your own password: at least 12 characters. A few unrelated words work well.',
          'Set up two-step verification. Scan the QR code with an authenticator app and enter the six-digit code, or add a passkey instead. Staff can’t do anything else until this is on.',
          'Save your recovery codes somewhere other than Atlas. They are shown once, and each one gets you in once if you lose your phone.',
        ],
      },
      {
        p: 'On your own computer you can tick Remember this browser for 30 days. Never tick it on a shared or client machine.',
      },
      { h: 'Add a passkey' },
      {
        p: 'Open the account menu (your initials, top right), choose Profile & sign-in, then Passkeys. Windows Hello, Touch ID, your phone or a security key all work. After that, Sign in with a passkey on the sign-in page skips the password and can’t be phished.',
      },
      { h: 'Find your way around' },
      {
        ul: [
          'Overview: the Dashboard, Expirations and Reports.',
          'Clients: the client directory and each client’s workspace.',
          'Documentation: Assets, the Knowledge base and Checklists.',
          'Password Vault: Passwords, My vault, Password health and Send.',
          'Press Ctrl+K anywhere to search everything you can see, or ? to see every keyboard shortcut.',
        ],
      },
      { h: 'What your access means' },
      {
        p: 'For each client you have one of No access, Read, Edit or Edit + passwords. Only Edit + passwords shows the client’s vault. A client you have no access to looks exactly like one that doesn’t exist, on purpose. If you can’t find a client you work on, ask an administrator to check your access.',
      },
      { h: 'Make it yours' },
      {
        ul: [
          'Star clients, assets and documents you use often; they appear on the Favorites card of your dashboard.',
          'Choose Customize on the dashboard to show, hide and reorder cards.',
          'Pick light or dark appearance, and your menu style under Profile & sign-in → Menu.',
          'Tick Email me about expirations on Profile & sign-in to get alerts and the Monday digest.',
        ],
      },
    ],
  },
  {
    key: 'guide-tech-find-anything',
    audience: 'technician',
    title: 'Find anything in seconds',
    description: 'Ctrl+K search, the client switcher, favourites and Atlas for Windows.',
    body: [
      {
        p: 'The fastest way to anything in Atlas is search. You rarely need to click through menus.',
      },
      { h: 'Search with Ctrl+K' },
      {
        ol: [
          'Press Ctrl+K (⌘K on a Mac) anywhere, or click Search in the header.',
          'Type a client, an asset name, an IP address, a serial number, a contact, or words from a document.',
          'Use the arrow keys and Enter to open a result, or Esc to close.',
        ],
      },
      {
        p: 'Results only include what you have access to, so a missing result can mean missing access rather than missing documentation.',
      },
      { h: 'Search tips' },
      {
        ul: [
          'Search a serial number from a device label to jump straight to its asset.',
          'Search part of an IP address to find which device or network holds it.',
          'Search a phrase from an error message to find the runbook that fixed it last time.',
          'Search a person’s name to find them as a contact and the documents that mention them.',
        ],
      },
      { h: 'Without opening a browser' },
      {
        p: 'With Atlas for Windows installed, press Ctrl+Shift+Space anywhere in Windows. It searches the same clients, assets, documents, contacts, locations and passwords. With a password selected, Enter copies it, and the clipboard is cleared after 30 seconds.',
      },
      { h: 'Keep your regulars close' },
      {
        ul: [
          'Click the star beside a client, asset or document to pin it to the Favorites card on your dashboard.',
          'In the rail menu style, the Go to list in the Clients panel jumps straight to any client.',
        ],
      },
    ],
  },
  {
    key: 'guide-tech-document-device',
    audience: 'technician',
    title: 'Document a new device',
    description: 'Add an asset with Smart paste, link it, check its warranty and print a QR label.',
    body: [
      {
        p: 'Every device we look after gets an asset. Devices synced from ConnectWise RMM arrive on their own, but anything else (a firewall, a switch, a printer, a device not yet in the RMM) is added by hand.',
      },
      { h: 'Add the asset' },
      {
        ol: [
          'Open the client and go to its Assets tab, then choose Add asset.',
          'Pick the layout, such as Configurations for a computer or Networks for a subnet.',
          'Fill in the fields. Atlas points out an IP address, date or web address in the wrong format before saving.',
          'Choose Save.',
        ],
      },
      { h: 'Let the device fill it in with Smart paste' },
      {
        ol: [
          'On the computer, run ipconfig /all, systeminfo or Get-ComputerInfo (Windows), system_profiler SPHardwareDataType (Mac) or hostnamectl (Linux).',
          'Copy what it prints.',
          'In the new asset, choose Smart paste and paste it, or just paste it into the Name box.',
          'Check what Atlas found, choose Fill in, then save. The text is read in your browser and isn’t sent or kept.',
        ],
      },
      { h: 'Connect it to everything else' },
      {
        ul: [
          'Under Related, choose Link to connect the asset to its admin password, its runbook, the contact who owns it and the location it’s in.',
          'Drag manuals, configuration backups or photos onto Files.',
          'Put anything that isn’t a field in Notes: quirks, the story behind a setting, what not to touch.',
        ],
      },
      { h: 'Warranty and labels' },
      {
        ul: [
          'Dell, Lenovo and HP hardware with a serial number gets its warranty end date automatically. Choose Check warranty to look again now.',
          'Choose QR label and print it for the device. Scanning it opens the asset after signing in; the label only shows the name, client and serial number.',
        ],
      },
      { h: 'When a device is retired' },
      {
        p: 'Choose Archive rather than deleting. It leaves lists and counts but keeps its history, and Restore brings it back.',
      },
    ],
  },
  {
    key: 'guide-tech-write-documents',
    audience: 'technician',
    title: 'Write documentation people will trust',
    description: 'Documents, folders, statuses, review dates, version history and share links.',
    body: [
      {
        p: 'Good documentation is written for the technician who has never seen this client, at 2 AM, with the server down. Lead with what to do, keep it current, and link it to what it’s about.',
      },
      { h: 'Client document or knowledge base?' },
      {
        ul: [
          'About one client (their backup process, their line-of-business app): the client’s Documents tab.',
          'Applies to every client (our standards, our procedures, vendor how-tos): Docs → Knowledge base. Client accounts never see the knowledge base.',
        ],
      },
      { h: 'Write it' },
      {
        ol: [
          'Choose New document and give it a clear Title, such as “Restart the Sage server safely”.',
          'Choose a Folder if the area uses them.',
          'Write it with headings, numbered steps, checklists, tables and code blocks.',
          'Set the Status: Current, Needs review or Draft.',
          'Set Review by for anything that goes out of date. It appears on the Expirations page when the date comes.',
          'Choose Save, then Link the assets, passwords and contacts it covers under Related.',
        ],
      },
      { h: 'Writing tips' },
      {
        ul: [
          'Start with one sentence saying when to use the document.',
          'Number the steps; one action per step.',
          'Never paste a password into a document. Link the vault entry instead.',
          'Say what “working” looks like, so the reader knows when they’re done.',
          'If a step surprised you, write down why. That’s the part the next person needs.',
        ],
      },
      { h: 'History and conflicts' },
      {
        p: 'Every save keeps the previous version. Version history shows who changed what; Compare shows the differences and Restore version puts an old one back. If someone else saved while you were editing, Atlas tells you instead of overwriting: copy your changes, reload, and apply them again.',
      },
      { h: 'Send a how-to to a client' },
      {
        p: 'Share makes a link anyone can open without signing in. They see that one document, as it is now, and nothing else. Choose how long the link works, and Revoke stops it at once. Check the document holds no passwords or anything about another client before you share it.',
      },
    ],
  },
  {
    key: 'guide-tech-passwords',
    audience: 'technician',
    title: 'Handle client passwords safely',
    description: 'Reveal, copy, add and change passwords, and hand them to people outside Atlas.',
    body: [
      {
        p: 'Every reveal, copy, change and share is recorded against your name. That protects you as much as the client. You see a client’s vault only with Edit + passwords access to that client.',
      },
      { h: 'Use a password' },
      {
        ul: [
          'On the client’s Passwords tab, copy the username, password or one-time code straight from the row.',
          'The eye shows the password; Copy password clears the clipboard after 30 seconds.',
          'If Atlas asks Why do you need this password?, give the ticket number.',
          'A restricted password asks you to confirm your own password first if you haven’t in the last 10 minutes. Atlas for Windows asks for Windows Hello every time.',
          'The six-digit one-time code updates live for accounts with an authenticator.',
        ],
      },
      { h: 'Add a password' },
      {
        ol: [
          'On the client’s Passwords tab, choose Add password and pick the Type.',
          'Fill in the Name, username, password and Website or address. The address is what the browser extension matches.',
          'Use the generator rather than inventing one.',
          'Paste the Authenticator setup key (TOTP) if the account has two-step sign-in, so the team gets the code too.',
          'Set Rotate every for passwords that should change, link the assets it belongs to, and choose Save.',
        ],
      },
      { h: 'Change a password' },
      {
        p: 'Edit the entry and enter the new one. The old password moves to Previous passwords with the date, so you can still find it if the change didn’t take everywhere.',
      },
      { h: 'Give a password to someone outside Atlas' },
      {
        ul: [
          'Quick share makes a link that opens once within 24 hours, and copies it. More options sets how many opens and when it expires.',
          'Send the link and the username through different channels, such as email for one and a text message for the other.',
          'For a licence key, a config file or instructions, use Vault → Send → New Send.',
          'Never paste a password into a ticket, chat or email.',
        ],
      },
      { h: 'Your own logins' },
      {
        p: 'Your own vendor portal account or payroll login belongs in Vault → My vault, which only you can open. Use Move to a client for anything the team needs.',
      },
    ],
  },
  {
    key: 'guide-tech-checklists',
    audience: 'technician',
    title: 'Run a checklist for a client',
    description: 'Start, assign, work through and hand over a checklist run.',
    body: [
      {
        p: 'Checklists make repeated work consistent: onboarding a user, setting up a laptop, patching a server. The checklist is the template; a run is one time you work through it for a client.',
      },
      { h: 'Start a run' },
      {
        ol: [
          'On the client’s Checklists tab, choose Start a checklist.',
          'Pick the Checklist, or write a one-off list of Steps.',
          'Choose who to Assign to, and set a Due date if there is one.',
        ],
      },
      { h: 'Work through it' },
      {
        ul: [
          'Tick each step as you do it. Atlas records who ticked it and when.',
          'Use Add a note to record what you found: serial numbers, licence counts, anything unexpected.',
          'An overdue run is marked, so it doesn’t get forgotten.',
        ],
      },
      { h: 'Hand it over' },
      {
        p: 'Markdown downloads the run as a text file for the ticket, and Print or PDF gives the client a record of what was done.',
      },
      { h: 'Improve the checklist' },
      {
        p: 'If a step was missing or wrong, tell whoever owns the checklist under Docs → Checklists, or fix it yourself if you can edit it. Changes apply to future runs, never to work already under way.',
      },
    ],
  },
  {
    key: 'guide-tech-extension-windows',
    audience: 'technician',
    title: 'Fill logins with the extension and Atlas for Windows',
    description: 'Sign in the browser extension and Atlas for Windows, fill logins and copy safely.',
    body: [
      {
        p: 'Two small apps put the vault where you work. Neither stores passwords: they ask Atlas each time, and every fill or copy is recorded like a reveal.',
      },
      { h: 'The browser extension (Edge and Chrome)' },
      {
        ol: [
          'Click the Atlas button in the browser toolbar, enter the Atlas address and choose Sign in through Atlas.',
          'In the tab that opens, check the code matches the extension, then choose Allow.',
          'On a sign-in page, click the Atlas button or press Alt+Shift+A.',
          'Choose Fill. On sites that ask for the username first, fill once for the username and again for the password.',
        ],
      },
      {
        p: 'Logins match when their Website or address has the same host or domain as the page. If a login isn’t offered, check its address in the vault.',
      },
      { h: 'Atlas for Windows' },
      {
        ol: [
          'Open Profile & sign-in, find Desktop apps, choose Download and run AtlasForWindowsSetup.exe. It doesn’t need an administrator.',
          'Enter the Atlas address and choose Sign in with your browser.',
          'Press Ctrl+Shift+Space anywhere, type, and press Enter to copy the selected password.',
        ],
      },
      {
        p: 'Where Windows Hello is set up, the app asks for it before showing or copying a password, and locks after a while without use.',
      },
      { h: 'If a laptop is lost' },
      {
        p: 'Sign the apps out from Signed-in apps and Desktop apps on your Profile & sign-in page, then tell an administrator.',
      },
    ],
  },
  {
    key: 'guide-tech-expirations',
    audience: 'technician',
    title: 'Stay ahead of expirations',
    description: 'The Expirations page, email alerts, domain and SSL trackers and warranties.',
    body: [
      {
        p: 'An expired certificate or domain is one of the most avoidable outages there is. Atlas watches the dates; your job is to look.',
      },
      { h: 'Check Expirations weekly' },
      {
        p: 'Overview → Expirations lists everything coming due, overdue first: asset dates marked as expiry dates (certificates, domains, licences, warranties), password rotations that are due, and documents whose Review by date has come.',
      },
      { h: 'Get it by email' },
      {
        p: 'Tick Email me about expirations on Profile & sign-in. You’ll get an alert before each item is due and a digest every Monday morning.',
      },
      { h: 'Domains and certificates' },
      {
        ul: [
          'Each client’s Domain Tracker and SSL Tracker tabs list expiry dates. A count turns amber when something needs attention.',
          'Choose Check now after renewing something, rather than waiting for the next scheduled check.',
          'If a date shows as unknown, the registry may not publish it or Atlas can’t reach the site on port 443. Type the date on the asset.',
        ],
      },
      { h: 'Renew it' },
      {
        p: 'Run the SSL certificate and domain renewal checklist for the client, or follow the Certificate and domain renewal runbook in the knowledge base. Start at least 30 days ahead.',
      },
    ],
  },
  {
    key: 'guide-tech-client-review',
    audience: 'technician',
    title: 'Prepare for a client review',
    description: 'Client health, the review pack and sharing reports with the client.',
    body: [
      {
        p: 'Atlas can build most of a quarterly business review for you. Spend your time on the conversation, not the slides.',
      },
      { h: 'Check the health score' },
      {
        p: 'Every client has a score from 0 to 100 beside its name, made of Security, Endpoints, Documentation and Renewals. Choose the score to see What would raise it most, with how many points each fix adds. Fixing the top two or three before the meeting is the quickest win.',
      },
      { h: 'Make the review pack' },
      {
        ol: [
          'Open the client and choose Review pack in the header. It captures the last quarter and downloads one PDF.',
          'Or open the client’s Reports tab, choose Client review pack, pick the period and choose Run report, then Review pack PDF.',
        ],
      },
      { h: 'Other reports worth running' },
      {
        ul: [
          'Savings finder: seats paid for and not used. Clients love this one.',
          'Cyber insurance readiness: the questions insurers ask, answered from Atlas.',
          'Upcoming renewals: what’s going to cost money soon.',
        ],
      },
      { h: 'Share it' },
      {
        p: 'On a single-client report, Share makes a link that works for 7, 30 or 90 days. The client can open it and download the PDF without an account. Revoke stops it at once.',
      },
    ],
  },
  {
    key: 'guide-tech-cant-see',
    audience: 'technician',
    title: 'When you can’t see or open something',
    description: 'Missing clients, passwords you can’t reveal, and sign-in problems.',
    body: [
      {
        p: 'Atlas hides what you don’t have access to rather than showing an error, so “missing” usually means “no access”.',
      },
      { h: 'A client is missing' },
      {
        p: 'Ask an administrator to check your access for that client, your groups and your role under People & access.',
      },
      { h: 'A password shows but won’t reveal' },
      {
        ul: [
          'You need Edit + passwords for the client, not just Edit.',
          'If the entry is restricted, you need to be on its Who can use it list.',
          'The client may require a reason before revealing.',
        ],
      },
      { h: 'You’re locked out' },
      {
        ul: [
          'After too many attempts, wait 15 minutes or ask an administrator to use Reset sign-in.',
          'Lost your phone? Use a recovery code, or ask an administrator to reset your two-step verification.',
          'Sign in with Microsoft says to wait? An administrator needs to confirm the link the first time.',
        ],
      },
      { h: 'Something looks wrong' },
      {
        p: 'Tell an administrator. Never work around access by asking a colleague to reveal a password for you; the access history records who revealed it.',
      },
    ],
  },

  {
    key: 'guide-tech-site-visit',
    audience: 'technician',
    title: 'Work on site with Site visit',
    description: 'One phone screen with the address, door notes, people, Wi-Fi and internet line for a client.',
    body: [
      {
        p: 'Before you drive out, open the client and choose Site visit at the top of their page. It puts what you need on site on one screen made for a phone, so you aren’t clicking through tabs in a car park.',
      },
      { h: 'What it shows' },
      {
        ul: [
          'Notes: the client’s quick notes and opening hours.',
          'Getting there and getting in: each location’s address (tap it to open maps), its phone number and the notes kept with it, such as door codes, alarm instructions and parking.',
          'People on site: primary contacts first, with tap-to-call numbers.',
          'Wi-Fi: the client’s Wi-Fi passwords. Copy is a normal reveal, so it may ask why and it’s recorded. Tap the network name for the join QR code.',
          'Internet: the provider, its support number, the circuit and account numbers, from the Internet / WAN assets.',
        ],
      },
      { h: 'Make it useful for the next visit' },
      {
        ul: [
          'Put door codes, alarm steps and where the comms cupboard is in the location’s Notes.',
          'Mark the main contact and the main site as Primary.',
          'Document the internet line as an Internet / WAN asset with its support phone number.',
          'Store the Wi-Fi as a password with the type Wi-Fi.',
        ],
      },
    ],
  },
  {
    key: 'guide-tech-verify-documents',
    audience: 'technician',
    title: 'Keep documents current with Verify',
    description: 'Confirming a document is still right, review dates, and what coverage means.',
    body: [
      {
        p: 'A document nobody has checked in a year is a guess. Verify records that you read it and it’s still right, without editing it, so the next person can trust it.',
      },
      { h: 'Verify a document' },
      {
        ol: [
          'Open the document and read it against what you know is true today.',
          'If something has changed, choose Edit and fix it. Saving counts as a check.',
          'If it’s still right, choose Verify. The badge changes to Verified today by you.',
        ],
      },
      {
        p: 'Verifying isn’t an edit: the version and Last updated stay. A document marked Needs review goes back to Current, and a review date moves six months ahead so the reminder comes round again.',
      },
      { h: 'What the badges mean' },
      {
        ul: [
          'Verified 12 days ago by Alex: someone checked it recently.',
          'Last verified in amber, or Not verified: nobody has checked or edited it for six months. It’s worth a read.',
        ],
      },
      { h: 'Coverage' },
      {
        p: 'The Documentation health report opens with each client’s coverage: how many of seven essentials are on record (a primary contact, a location, a network diagram, a backup runbook, the internet provider, admin accounts and Wi-Fi) and which are missing. Fill the gaps when you’re next working on that client.',
      },
    ],
  },
  {
    key: 'guide-tech-requests',
    audience: 'technician',
    title: 'Handle starter, leaver and change requests',
    description: 'What a request from a client looks like, and working it through to done.',
    body: [
      {
        p: 'Clients and the team can ask for work from inside Atlas. Each request starts a checklist for that client, so nothing lives only in someone’s inbox.',
      },
      { h: 'Where requests come from' },
      {
        ul: [
          'Starter or leaver, on a client’s Contacts tab or a client’s own portal home. It starts New starter: name or Leaver: name, using the user onboarding or offboarding checklist, due on their first or last day.',
          'Request a change, on a client’s portal home. It starts Change request: what they asked for, with four short steps.',
          'Who asked, and their details, are on the first step. Everyone on the team who can edit that client gets an email.',
        ],
      },
      { h: 'Work a request' },
      {
        ol: [
          'Open Checklists, or the client’s Checklists tab. New requests are unassigned.',
          'Assign it to yourself so the rest of the team knows it’s taken.',
          'Read the first step’s note, and ask the client about anything unclear before you start.',
          'Tick each step as you go, with a short note where it helps the next person.',
          'For a leaver, rotate any shared passwords they knew and archive their contact.',
        ],
      },
      {
        p: 'When the last step is ticked the checklist is complete, and it stays in the client’s history.',
      },
    ],
  },
  {
    key: 'guide-tech-faster',
    audience: 'technician',
    title: 'Move faster: shortcuts, previews and saved views',
    description: 'Keyboard shortcuts, hover previews, list views that remember you, and pinned reports.',
    body: [
      { p: 'Small things that add up over a day in Atlas.' },
      { h: 'Keyboard shortcuts' },
      {
        ul: [
          'Press ? anywhere to see them all.',
          '/ opens search, as Ctrl+K does.',
          'g then a letter goes to a page: g c Clients, g a Assets, g d Documents, g p Passwords, g r Reports, g e Expirations, g o Overview.',
          'Shortcuts never fire while you’re typing in a field.',
        ],
      },
      { h: 'Hover previews' },
      {
        p: 'Rest the mouse on a link to an asset or document, anywhere in Atlas, and a card shows what it is: the asset’s type, client and key fields, or the document’s first lines. It tells similar names apart without opening each one.',
      },
      { h: 'Lists that remember you' },
      {
        ul: [
          'Assets, Documents and Passwords keep your Sort (and Passwords your grouping) on your account, on any computer.',
          'On Assets, pick a type such as Configurations, then Columns, to choose up to six of its fields to show.',
        ],
      },
      { h: 'Pinned reports' },
      {
        p: 'In Reports → Templates, the pin beside a saved template puts it on your dashboard. One click opens it ready to run.',
      },
      { h: 'Who used a password last' },
      {
        p: 'A password’s page says who last used it, beside when it was updated. The full record is in Access history.',
      },
    ],
  },
  // ---------- clients ----------
  {
    key: 'guide-client-welcome',
    audience: 'client',
    title: 'Welcome to your IT documentation',
    description: 'What a client account is, what it shows and how to sign in for the first time.',
    body: [
      {
        p: 'Your IT provider uses Atlas to document your organization: your computers and equipment, how things are set up, your contacts and locations, and the passwords they look after. Your account lets you see that documentation yourself.',
      },
      { h: 'What you can see' },
      {
        ul: [
          'Your organization’s documentation: equipment, documents, contacts and locations.',
          'Passwords your provider has chosen to share with you.',
          'Nothing about any other organization.',
        ],
      },
      { h: 'Sign in for the first time' },
      {
        ol: [
          'Open the address your IT provider gave you.',
          'Sign in with your email address and the temporary password.',
          'Choose your own password: at least 12 characters. A few unrelated words are easy to remember and hard to guess.',
        ],
      },
      { h: 'Find your way around' },
      {
        ul: [
          'Your dashboard shows a welcome message from your provider, usually with how to reach their help desk.',
          'Press Ctrl+K (⌘K on a Mac) to search for anything you can see.',
          'Your initials in the top-right corner open your account menu.',
        ],
      },
      { h: 'Need something changed?' },
      {
        p: 'If your account is a Client viewer, you can read but not change. Ask your IT provider, or ask them to make you a Client editor if you keep your own documentation.',
      },
    ],
  },
  {
    key: 'guide-client-secure-account',
    audience: 'client',
    title: 'Keep your account secure',
    description: 'Two-step verification, passkeys, changing your password and signing out of other devices.',
    body: [
      {
        p: 'Your account can show passwords to your organization’s systems, so protect it like your email.',
      },
      { h: 'Turn on two-step verification' },
      {
        ol: [
          'Open your account menu (your initials, top right) and choose Profile & sign-in.',
          'Set up an authenticator app (Microsoft Authenticator, Google Authenticator and so on) by scanning the QR code and entering the six-digit code.',
          'Save your recovery codes somewhere safe. Each gets you in once if you lose your phone.',
        ],
      },
      { h: 'Use a passkey' },
      {
        p: 'Under Passkeys, add Windows Hello, Touch ID, your phone or a security key. Then choose Sign in with a passkey on the sign-in page: no password to type, and nothing to phish.',
      },
      { h: 'Change your password' },
      {
        p: 'Choose Change password on Profile & sign-in. Changing it signs out your other devices.',
      },
      { h: 'Check where you’re signed in' },
      {
        p: 'Where you’re signed in lists every browser using your account. Choose Sign out beside any you don’t recognize, then change your password and tell your IT provider.',
      },
      { h: 'Forgot your password?' },
      {
        p: 'Choose Forgot your password? on the sign-in page. The emailed link works once, for an hour.',
      },
    ],
  },
  {
    key: 'guide-client-view-password',
    audience: 'client',
    title: 'View a password your IT provider shared',
    description: 'Find, reveal and copy a shared password, and why each view is recorded.',
    body: [
      {
        p: 'Your IT provider can share some passwords with you, such as the Wi-Fi password or a login your office manager needs. You can see only the passwords they chose to share.',
      },
      { h: 'Find and reveal it' },
      {
        ol: [
          'Open your organization from Clients and go to its Passwords tab, or press Ctrl+K and type the name of the system.',
          'Open the entry and choose Show (the eye).',
          'If you’re asked for a reason, say briefly why you need it, such as “setting up the new reception PC”.',
        ],
      },
      { h: 'Why each view is recorded' },
      {
        p: 'Every time a password is shown, your provider sees who viewed it and when. This isn’t about distrust: if a password leaks, the record shows who could have seen it, which makes the investigation quick and keeps suspicion off everyone else.',
      },
      { h: 'Good habits' },
      {
        ul: [
          'Don’t write shared passwords down or send them by email or text.',
          'Don’t save them in your browser on a shared computer.',
          'If you think a password has been seen by someone who shouldn’t have it, tell your IT provider straight away so they can change it.',
        ],
      },
      { h: 'Can’t see a password you need?' },
      {
        p: 'Ask your IT provider to share it with you. Some providers let you see that a password exists without revealing it; they can tell you how they’ve set this up.',
      },
    ],
  },
  {
    key: 'guide-client-find-documentation',
    audience: 'client',
    title: 'Find your organization’s documentation',
    description: 'Search, equipment, documents, contacts and locations.',
    body: [
      {
        p: 'Everything your provider has documented and shared with you is in one place, and searchable.',
      },
      { h: 'Search first' },
      {
        p: 'Press Ctrl+K (⌘K on a Mac) and type a name, a device, a person or words from a document. Use the arrow keys and Enter to open a result.',
      },
      { h: 'What’s where' },
      {
        ul: [
          'Assets: your computers, servers, printers, network equipment, domains and licences, with details such as serial numbers and warranty dates.',
          'Documents: how-tos and procedures your provider has written for you.',
          'Contacts: the people at your organization your provider deals with.',
          'Locations: your offices and sites.',
        ],
      },
      { h: 'Useful things to look up' },
      {
        ul: [
          'A computer’s serial number or warranty date, before calling the manufacturer.',
          'Which licences you have and how many.',
          'The how-to your provider wrote for a common task, such as connecting to the printer.',
        ],
      },
      { h: 'Something is wrong or out of date' },
      {
        p: 'Tell your IT provider. If you’re a Client editor, you can correct it yourself, and the change is recorded in the item’s history.',
      },
    ],
  },
  {
    key: 'guide-client-keep-current',
    audience: 'client',
    title: 'Keep your documentation up to date',
    description: 'For Client editors: updating contacts, locations, assets and documents.',
    body: [
      {
        p: 'If your account is a Client editor, you can keep your organization’s documentation current yourself. Your IT provider sees every change, and nothing is lost: every save keeps the previous version.',
      },
      { h: 'Tell us when people change' },
      {
        ul: [
          'A new starter: add them on Contacts with Add contact, so your provider knows who they are when they call.',
          'Someone leaving: tell your IT provider the date so their accounts are closed on time, and update their contact.',
          'A new main contact: tick Primary contact on their entry.',
        ],
      },
      { h: 'Offices and equipment' },
      {
        ul: [
          'A new office or a changed address: update Locations.',
          'New equipment you bought yourself: tell your provider, or add it under Assets if you know its details.',
        ],
      },
      { h: 'Documents' },
      {
        p: 'Edit a document, make your change and choose Save. If someone else saved while you were editing, Atlas tells you rather than overwriting their work: copy your changes, reload, and apply them again.',
      },
      { h: 'Please don’t' },
      {
        ul: [
          'Put passwords in documents or notes. Ask your provider to store them in the vault.',
          'Delete something you’re unsure about. Ask first; it may be needed to support you.',
        ],
      },
    ],
  },
  {
    key: 'guide-client-receive-securely',
    audience: 'client',
    title: 'Receive a password or file securely',
    description: 'What to do with a one-time link from your IT provider.',
    body: [
      {
        p: 'Your IT provider won’t email you a password. Instead they send a secure link that opens once, or a few times, and then stops working.',
      },
      { h: 'Open the link' },
      {
        ol: [
          'Open the link in your browser. You don’t need an account.',
          'Copy the password, or download the file, straight away.',
          'Store it where it belongs: your own password manager, or the system it’s for.',
        ],
      },
      { h: 'Why it works this way' },
      {
        ul: [
          'The content is encrypted in your provider’s browser; the key is only in the link, and never reaches the server.',
          'Once opened, or once it expires, the link stops working, so an old email can’t leak it later.',
          'The username often comes separately, by another route. That’s deliberate.',
        ],
      },
      { h: 'If the link says it has expired' },
      {
        p: 'It was already opened or ran out of time. Ask your provider for a new one. If you didn’t open it yourself, tell them: someone else may have.',
      },
      { h: 'Never' },
      {
        p: 'Never reply with a password by email, and be wary of any message asking you to enter a password on a page you didn’t expect. Your IT provider will never ask for your password.',
      },
    ],
  },
  {
    key: 'guide-client-read-reports',
    audience: 'client',
    title: 'Read the reports your IT provider sends',
    description: 'Opening a shared report, what the sections mean and downloading the PDF.',
    body: [
      {
        p: 'Your IT provider may send a report link before a review meeting, or on a schedule. The link opens without an account.',
      },
      { h: 'Open and download' },
      {
        ul: [
          'Open the link to see the report, every section as it was captured. If you sign in to Atlas, reports shared with you are also listed on your Overview under Shared reports.',
          'Download the whole report, or one section, as a PDF.',
          'The link works for a set time (7, 30 or 90 days), and your provider can turn it off.',
        ],
      },
      { h: 'What you may see' },
      {
        ul: [
          'Health score: 0 to 100, made of security, endpoints, documentation and renewals. Higher is better; the arrow shows the trend.',
          'Security posture: weak or reused passwords (never the passwords themselves), devices without protection and disks not encrypted.',
          'Upcoming renewals: what’s due to be renewed, and when.',
          'Savings finder: licences paid for and not used.',
          'Needs review: rows your provider has flagged to talk about.',
        ],
      },
      { h: 'Bring questions' },
      {
        p: 'Mark anything you don’t understand or want to change. The review meeting is the place to decide what to fix, what to renew and what to stop paying for.',
      },
    ],
  },

  {
    key: 'guide-client-requests',
    audience: 'client',
    title: 'Ask for a new starter, a leaver or a change',
    description: 'Telling your IT provider about people joining or leaving, or anything else you need, from Atlas.',
    body: [
      {
        p: 'You can ask your IT provider for work straight from Atlas. It goes to their team as a checklist, so it isn’t lost in an inbox, and you have a record of when you asked.',
      },
      { h: 'Someone is joining or leaving' },
      {
        ol: [
          'Sign in to Atlas. Your Overview has a card for your organization.',
          'Choose Starter or leaver.',
          'Choose Someone is joining or Someone is leaving, then enter their name and first or last day.',
          'Under Details, add their job title, manager, what they need access to, or what should happen to their email and files.',
          'Choose Send request.',
        ],
      },
      {
        p: 'Tell your provider as early as you can. A leaver’s access should end at the agreed time, not days later.',
      },
      { h: 'Anything else' },
      {
        ol: [
          'Choose Request a change on your organization’s card.',
          'Say what you need, such as a shared mailbox for sales, a printer moved or a door code changed.',
          'Add the details and, if there’s a deadline, the date it’s needed by.',
          'Choose Send request.',
        ],
      },
      {
        p: 'For anything urgent, such as a suspected break-in to an account, call your provider as well.',
      },
    ],
  },
  // ---------- administrators ----------
  {
    key: 'guide-admin-setup',
    audience: 'admin',
    title: 'Set Atlas up for your team',
    description: 'The first jobs after installing: email, theme, people, data, backups.',
    body: [
      {
        p: 'Work through these in order the first week. Most take a few minutes each.',
      },
      { h: 'Make it safe' },
      {
        ol: [
          'Keep a copy of the master key in a password manager and on paper, away from the server and backups.',
          'Open Admin → System status and check backups run nightly. Point ATLAS_BACKUP_DIR at a network share so backups aren’t on the same disk.',
          'If browsers warn about the certificate, open Admin → Certificate and install the authority on staff computers, or give Atlas a public DNS name.',
        ],
      },
      { h: 'Make it yours' },
      {
        ol: [
          'Admin → Email & alerts: tick Send email from Atlas, set up Microsoft 365 (app registration), choose Save, then Send test.',
          'Set the alert days (for example 30, 14 and 7) and the Monday digest under Alerts and logs.',
          'Admin → Theme: brand name, logo, accent colour, and the welcome message client accounts see.',
        ],
      },
      { h: 'Bring your data in' },
      {
        ul: [
          'Admin → Import & export → Hudu, CSV, ConnectWise RMM, Microsoft 365 or Bitdefender GravityZone.',
          'Docs → Checklists → Template library, and Docs → Knowledge base → Template library, for ready-made checklists, runbooks and these guides.',
          'Admin → Duplicates afterwards, to merge anything that came in twice.',
        ],
      },
      { h: 'Invite people' },
      {
        p: 'Add your technicians under Admin → People & access, ideally through groups. Share the technician guides in this folder with them on their first day.',
      },
    ],
  },
  {
    key: 'guide-admin-people-access',
    audience: 'admin',
    title: 'Add people and manage access',
    description: 'Roles, client access levels, groups and the safeguards around them.',
    body: [
      {
        p: 'Atlas decides everything by role and by client. Give people the least access that lets them do their job; it’s easy to raise later.',
      },
      { h: 'Add a person' },
      {
        ol: [
          'Go to Admin → People & access and choose Add person.',
          'Enter their Name and Email, and choose their Role.',
          'Under Client access, set Every client (including new ones), then raise it for individual clients if needed.',
          'Choose Create account and pass on the temporary password through a different channel from their email address.',
        ],
      },
      { h: 'Choosing a role' },
      {
        ul: [
          'Owner: everything, including vault policies. Keep to one or two people.',
          'Administration: every client including passwords, plus people, settings, imports and system.',
          'Technician: the clients they’re given, up to editing passwords.',
          'Read-only technician: trainees and auditors.',
          'Client editor and Client viewer: a client’s own staff.',
        ],
      },
      { h: 'Access levels' },
      {
        p: 'Each client is No access, Read, Edit or Edit + passwords. Someone’s access is the highest of their own and their groups’ levels, never more than their role allows, and changes apply immediately, even to people signed in.',
      },
      { h: 'Use groups' },
      {
        p: 'Admin → Groups gives a team access to a set of clients in one place. New starter? Add them to the group instead of setting each client. Groups can also be named on restricted passwords.',
      },
      { h: 'Review it quarterly' },
      {
        p: 'Check People & access for anyone who hasn’t signed in for a while, anyone without two-step verification, and access that’s wider than it needs to be.',
      },
    ],
  },
  {
    key: 'guide-admin-client-portal',
    audience: 'admin',
    title: 'Give a client’s staff access',
    description: 'Client accounts, sharing passwords with them and the welcome message.',
    body: [
      {
        p: 'A client account sees only its own organization, and only what you share. It never sees the knowledge base, other clients, checklists or administration.',
      },
      { h: 'Create the account' },
      {
        ol: [
          'Go to Admin → People & access and choose Add person.',
          'Enter their name and email.',
          'Choose Client viewer to read, or Client editor to also keep their documentation up to date.',
          'Under Client access, give them their own organization, then choose Create account.',
        ],
      },
      { h: 'Share passwords' },
      {
        ul: [
          'Open a password and tick Share with the client’s own accounts.',
          'For several at once, tick them on the client’s Passwords tab and change their client portal sharing together.',
          'To let client viewers see which passwords exist without revealing them, the owner ticks Don’t let read-only accounts reveal passwords in Vault policies.',
        ],
      },
      { h: 'Welcome them' },
      {
        ul: [
          'Set the Welcome message under Admin → Theme with how to reach your help desk.',
          'Share the client guides from this folder with them by link: welcome, keeping their account secure and viewing shared passwords are a good start.',
        ],
      },
    ],
  },
  {
    key: 'guide-admin-offboard',
    audience: 'admin',
    title: 'Offboard someone who is leaving',
    description: 'Disable the account, end sessions and keep their work.',
    body: [
      {
        p: 'Do this on their last day, ideally while they’re still with you.',
      },
      { h: 'Before they go' },
      {
        ul: [
          'Ask them to use Move to a client for anything in My vault the company needs. Nobody can open a personal vault after the account is closed.',
          'Reassign their open checklist runs. Their scheduled reports stop once they can’t sign in, so recreate any that are still needed.',
        ],
      },
      { h: 'Disable the account' },
      {
        ol: [
          'Go to Admin → People & access and choose Manage on the person.',
          'Tick Disable this account. Their sessions end at once, and the browser extension and Atlas for Windows are signed out.',
          'Their history stays, so the security log and access history still show what they did.',
        ],
      },
      { h: 'Rotate what they knew' },
      {
        p: 'Check Admin → Security log → Vault access for passwords they revealed recently, and change the sensitive ones: domain admin, firewall and global admin accounts first. Revoke any API keys they made.',
      },
      { h: 'Lost device instead of a leaver?' },
      {
        p: 'Use Sign out everywhere to end every session without disabling the person, then Reset sign-in with Also reset two-step verification if their phone was taken.',
      },
    ],
  },
  {
    key: 'guide-admin-sso',
    audience: 'admin',
    title: 'Set up single sign-on',
    description: 'Microsoft Entra ID or SAML sign-in for staff, safely.',
    body: [
      {
        p: 'Staff can sign in with Microsoft Entra ID or any SAML 2.0 provider (Okta, Google Workspace, Duo, JumpCloud and others), under Admin → Sign-in.',
      },
      { h: 'How it behaves' },
      {
        ul: [
          'Signing in never creates an account. Add the person in Atlas first, with the same email they have at the provider.',
          'The first time someone signs in, an administrator confirms the link under People & access → Manage with Confirm Microsoft account or Confirm SAML account.',
          'The owner can always use a password, so a provider outage never locks everyone out.',
        ],
      },
      { h: 'Microsoft Entra ID' },
      {
        ol: [
          'In the Entra admin center, make a separate app registration for sign-in and add the Web redirect address shown on the Microsoft sign-in card.',
          'Create a client secret and copy its Value. Note when it expires.',
          'In Atlas, enter the Sign-in tenant ID, Sign-in app ID and Sign-in secret.',
          'Tick Show “Sign in with Microsoft” on the sign-in page and choose Save Microsoft sign-in.',
          'Try it in a private window before you tick Require Microsoft sign-in for staff.',
        ],
      },
      { h: 'SAML' },
      {
        ol: [
          'In the provider, add a SAML app with the Single sign-on (ACS) URL and Audience (SP entity ID) from the SAML sign-in card. Send email as an attribute named email, and sign the assertion.',
          'In Atlas, enter the Identity provider name, Provider issuer (entity ID), Provider sign-on URL and Provider signing certificate.',
          'Tick Show “Sign in with your provider” on the sign-in page, choose Save SAML sign-in, and test in a private window.',
        ],
      },
      {
        p: 'Start sign-in from the Atlas sign-in page, not the provider’s app tile: Atlas refuses a response it didn’t ask for.',
      },
    ],
  },
  {
    key: 'guide-admin-vault-policies',
    audience: 'admin',
    title: 'Lock down the vault',
    description: 'Vault policies, restricted passwords, required reasons, emergency access and SIEM.',
    body: [
      {
        p: 'Administrators can read every password; Atlas isn’t end-to-end encrypted. It records every read instead and lets you narrow who can see what. These are the controls, from simplest to strictest.',
      },
      { h: 'Restrict the crown jewels' },
      {
        p: 'Edit a password, tick Restricted, and choose the groups and people under Who can use it. Everyone else can’t see the entry exists. Do this for domain admin, global admin, firewall and payroll logins.',
      },
      { h: 'Vault policies (owner only)' },
      {
        ul: [
          'MFA: lists every account that can reach passwords without two-step verification.',
          'Generator: the shortest password allowed and the character rules.',
          'Require a reason for every reveal, copy, and share, for every client.',
          'Don’t let read-only accounts reveal passwords.',
          'Restricted passwords are for the people listed on them: administrators need a place on the list too.',
          'Give each staff member a personal vault.',
        ],
      },
      { h: 'Emergency access' },
      {
        p: 'For when the owner can’t be reached. The owner names trusted administrators, each with a wait from one hour to a week. A request emails the owner, who can Deny or Approve now; otherwise access starts after the wait and lasts 24 hours.',
      },
      { h: 'Watch it' },
      {
        ul: [
          'Vault → Password health: weak, reused, breached and overdue passwords, lowest-scoring client first.',
          'Admin → Security log → Vault access: every reveal, copy, change and share.',
          'Stream logs to a SIEM sends events by webhook or syslog as they happen.',
        ],
      },
    ],
  },
  {
    key: 'guide-admin-weekly-check',
    audience: 'admin',
    title: 'Weekly health check',
    description: 'Ten minutes a week: backups, disk, security log, updates and syncs.',
    body: [
      {
        p: 'Put this in your calendar every Monday. It catches almost every problem before anyone notices.',
      },
      { h: 'System status' },
      {
        ul: [
          'Admin → System status: the last good backup, the next one, and any red rows with their reason. Accounts and API keys unused for 60 days are listed here too.',
          'Disk space for the data and backup folders.',
          'Email and the master key in use.',
        ],
      },
      { h: 'Security log' },
      {
        ul: [
          'Admin → Security log → Verify now. A break means someone changed the database directly: keep the server as it is, export the log and investigate.',
          'Skim failures and lockouts for anything unusual.',
        ],
      },
      { h: 'Integrations' },
      {
        ul: [
          'Admin → Import & export: read the last ConnectWise RMM, Microsoft 365 and Bitdefender sync messages.',
          'Vault → Password rotation → Recent attempts, if you use rotation.',
          'Admin → Webhooks: any paused webhook needs its receiver fixed and Resume.',
        ],
      },
      { h: 'Updates' },
      {
        p: 'Admin → Updates lists newer releases with their notes. Read them, then install outside working hours; Atlas takes a backup first and puts the previous version back if the install fails.',
      },
      { h: 'Monthly' },
      {
        ul: [
          'Download a backup and check it can be read with npm run backup -w @atlas/server -- verify <file>.',
          'Review People & access for leavers and over-wide access.',
          'Start an access review for any client whose Access review card says Due.',
          'Note when the Microsoft app registration secrets used for email and sign-in expire, and renew them in time.',
        ],
      },
    ],
  },
  {
    key: 'guide-admin-backup-restore',
    audience: 'admin',
    title: 'Back up and restore Atlas',
    description: 'How backups work, taking one now, and restoring the whole system.',
    body: [
      {
        p: 'Atlas backs itself up every night into one encrypted .atlasbak file holding the whole database and every attachment, and keeps the newest 14. A backup can only be read with the master key it was made with.',
      },
      { h: 'Take one now' },
      {
        p: 'Admin → System status → Back up now. Download saves a copy; Atlas asks for your password first. Take one before any big import or change.',
      },
      { h: 'Keep them safe' },
      {
        ul: [
          'Point ATLAS_BACKUP_DIR at a network share, or copy the folder off the server on a schedule.',
          'Keep the master key somewhere other than the backups.',
          'After rotating the master key, keep the old key listed until older backups age out.',
        ],
      },
      { h: 'Restore' },
      {
        ol: [
          'Stop Atlas.',
          'Make sure the master key the backup was made with is loaded.',
          'Check the file: npm run backup -w @atlas/server -- verify <file.atlasbak>',
          'Restore into a new, empty database: npm run restore -w @atlas/server -- <file.atlasbak> (add --replace to overwrite the current one).',
          'Start Atlas. Everyone signs in again.',
        ],
      },
      {
        p: 'The restore checks the whole file before it changes anything, and a backup from an older version is upgraded as it loads.',
      },
      { h: 'Practise' },
      {
        p: 'Restore to a test server once a quarter, and note how long it took. That’s your real recovery time.',
      },
    ],
  },
  {
    key: 'guide-admin-integrations',
    audience: 'admin',
    title: 'Connect your tools',
    description: 'Hudu, spreadsheets, ConnectWise RMM, Microsoft 365, Bitdefender and the BitLocker collector.',
    body: [
      {
        p: 'Everything here is under Admin → Import & export, except the BitLocker collector and password rotation, which are in the Vault area. Take a backup before the first big import.',
      },
      { h: 'Hudu' },
      {
        p: 'Create an API key in Hudu, then Import & export → Hudu, enter the address and key, and choose Connect. Preview counts what’s there; Start import runs it. Running it again updates rather than duplicates.',
      },
      { h: 'Spreadsheets' },
      {
        p: 'Import & export → CSV brings in clients, contacts, locations, assets or passwords. Always choose Check the file first: it reports every problem by row and saves nothing.',
      },
      { h: 'ConnectWise RMM' },
      {
        ol: [
          'In ConnectWise RMM, create a client ID and secret under Integrations → API Access, with tickets read, and Automation read and create if you’ll rotate passwords.',
          'Enter them under Import & export → ConnectWise RMM.',
          'Link each company to a client, choose what to sync, and Sync now. It then runs every hour.',
        ],
      },
      { h: 'Microsoft 365 and Bitdefender' },
      {
        ul: [
          'Microsoft 365 documents each tenant’s users, licences and domains; GDAP adds license management and the Microsoft 365 reports.',
          'Bitdefender GravityZone reads endpoint protection per client, read-only, every hour.',
        ],
      },
      { h: 'BitLocker collector' },
      {
        p: 'Vault → BitLocker collector makes an enrollment per client with a script your RMM runs as SYSTEM every 6 hours. Keep the script like a password: it holds an upload token.',
      },
      { h: 'Afterwards' },
      {
        p: 'Open Admin → Duplicates and merge anything that came in twice.',
      },
    ],
  },
  {
    key: 'guide-admin-api-webhooks',
    audience: 'admin',
    title: 'Automate with API keys and webhooks',
    description: 'Let scripts read and update Atlas, and let other tools react to changes.',
    body: [
      { h: 'API keys' },
      {
        ol: [
          'Admin → API keys → New key. Atlas asks for your password again.',
          'Give it a Name, choose its scopes (read, write, and passwords only if it truly needs them) and when it Expires.',
          'Copy the key. It’s shown once; Atlas keeps only a hash.',
        ],
      },
      {
        ul: [
          'A key acts as you, with your access, limited to its scopes. For a shared integration, consider a dedicated account with only the access it needs.',
          'The API is at /api/v1, described at /api/v1/openapi.json, and only grows within v1.',
          'Every use is in the security log. Revoke keys you no longer use.',
        ],
      },
      { h: 'Webhooks' },
      {
        ol: [
          'Admin → Webhooks → New webhook, with a name, an https:// address and the kinds of item to hear about.',
          'Copy the signing secret, shown once, so the receiver can check messages came from Atlas.',
          'Choose Send test to post a ping.',
        ],
      },
      {
        p: 'Messages name the event, who did it, the client and the item, never its contents. Leave Assets unticked on a webhook that posts to a chat channel; an RMM sync changes many at once.',
      },
    ],
  },
  {
    key: 'guide-admin-access-review',
    audience: 'admin',
    title: 'Run a client access review',
    description: 'Checking who can open a client every quarter, removing what isn’t needed, and signing it off.',
    body: [
      {
        p: 'Insurers and auditors increasingly ask who can see a client’s data, and when someone last checked. An access review answers both, and the signed PDF is the evidence.',
      },
      { h: 'Run a review' },
      {
        ol: [
          'Open the client. The Access review card on its Overview says when it was last signed off, and Due if that was more than 90 days ago.',
          'Choose Start review. Atlas lists everyone who can open the client now, with their role, access level, where the access comes from (Direct, a group, or All clients), two-factor status and last sign-in.',
          'Choose Keep or Remove for each person. Remove takes away their direct access at once.',
          'If someone still has access through a group or the all-clients level, the card says so. Change that under People & access, since it affects other clients too.',
          'Type your name under Signed off by and choose Sign off.',
        ],
      },
      { h: 'Afterwards' },
      {
        ul: [
          'PDF beside a signed-off review downloads it for the client’s file or their insurer.',
          'A signed-off review can’t be changed. Start a new one next quarter.',
          'Every step, including each removal, is in the security log.',
          'The security report’s Who has access section gives the same list at any time, without a sign-off.',
        ],
      },
    ],
  },
  {
    key: 'guide-admin-evidence',
    audience: 'admin',
    title: 'Prepare evidence for an auditor or insurer',
    description: 'The client evidence pack, the compliance evidence pack, and the insurance readiness report.',
    body: [
      {
        p: 'Atlas can put together most of what an auditor or a cyber insurer asks for. Run these the week before you need them, and fix what they find first.',
      },
      { h: 'For one client' },
      {
        ul: [
          'On the client’s Reports tab, Evidence pack downloads a zip of PDFs: security posture, cyber insurance readiness, endpoint health, documentation health, asset inventory and licence utilization.',
          'The Cyber insurance readiness report answers the usual questionnaire (MFA, endpoint protection, encryption, backups and so on) with the evidence for each answer and what to do where it’s No.',
          'Sign off an access review first, so the pack shows current access.',
        ],
      },
      { h: 'For your whole organization' },
      {
        ol: [
          'Open Admin → Security log.',
          'Choose Compliance evidence pack and confirm your password.',
          'The zip holds an integrity check of the security log, run as it’s made; the security log itself; every account’s two-factor status; your vault policies; and each client’s latest signed-off access review, with a summary of which are due.',
        ],
      },
      {
        p: 'Read the README first: it sums up the log check, two-factor coverage and access reviews in a line each. Passwords and document contents are never included.',
      },
    ],
  },
  {
    key: 'guide-admin-portfolio',
    audience: 'admin',
    title: 'Watch your portfolio: health map, team pulse and the Monday email',
    description: 'Seeing every client and the team at a glance, and what Atlas tells you without asking.',
    body: [
      { p: 'A few views show where to spend the week, without opening every client.' },
      { h: 'Health map' },
      {
        p: 'Clients → Health map shows every client against each part of its health score: security, endpoints, documentation and renewals. The lowest is at the top, and red cells are where to start. Select a cell to open the client.',
      },
      { h: 'Team pulse' },
      {
        p: 'The Team pulse card on your dashboard shows what each person changed in the last 30 days, against the 30 before, and how many stale documents (untouched for six months) each of them edited last. Use it to share out review work, not to rank people.',
      },
      { h: 'What arrives by email' },
      {
        ul: [
          'Monday morning: the average client health score, how it moved, and every client that moved by 3 points or more. Owners and administrators get it while the weekly digest is on.',
          'Straight away: an email when Bitdefender reports an infected endpoint at a client you can see.',
          'When someone asks: starter, leaver and change requests go to everyone who can edit that client.',
        ],
      },
      { h: 'Keep access tidy' },
      {
        ul: [
          'System status warns about accounts and API keys nobody has used for 60 days, and People & access marks inactive accounts.',
          'Disable leavers’ accounts, and revoke keys nothing uses.',
          'The Client onboarding card on the Clients page shows each new client’s onboarding checklist and how long onboarding takes on average.',
        ],
      },
    ],
  },
];
