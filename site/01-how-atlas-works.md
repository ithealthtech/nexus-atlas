---
title: How Atlas fits together
nav: How Atlas fits together
out: manual/how-atlas-works.html
group: Using Atlas
order: 1
number: 1
summary: What Atlas is, the parts it is made of, and how the apps and integrations connect to it.
---

# How Atlas fits together

Atlas is one place for everything your team knows about each client: their devices, procedures, contacts, locations and passwords. It runs on a server you own, and everyone reaches it with a web browser.

<div class="diagram" role="img" aria-label="Browsers, the browser extension and Atlas for Windows connect over HTTPS to the web proxy, which passes requests to Atlas. Atlas stores everything in PostgreSQL and keeps encrypted backups. It reads devices and tickets from ConnectWise, tenants from Microsoft 365, and checks warranties, domains and certificates.">
<svg viewBox="0 0 790 330" xmlns="http://www.w3.org/2000/svg">
<rect class="box" x="10" y="20" width="190" height="56" rx="8"/><text class="t" x="26" y="44">Web browser</text><text class="s" x="26" y="62">Technicians, admins, clients</text>
<rect class="box" x="10" y="96" width="190" height="56" rx="8"/><text class="t" x="26" y="120">Browser extension</text><text class="s" x="26" y="138">Fills logins in Edge, Chrome</text>
<rect class="box" x="10" y="172" width="190" height="56" rx="8"/><text class="t" x="26" y="196">Atlas for Windows</text><text class="s" x="26" y="214">Quick search from the tray</text>
<path class="line" d="M200 48h40v76M200 124h40M200 200h40v-76M240 124h30"/>
<rect class="box" x="270" y="96" width="130" height="56" rx="8"/><text class="t" x="286" y="120">Web proxy</text><text class="s" x="286" y="138">HTTPS, certificate</text>
<path class="line" d="M400 124h30"/>
<rect class="box box-main" x="430" y="80" width="150" height="88" rx="8"/><text class="t" x="446" y="108">MSP Atlas</text><text class="s" x="446" y="128">Documentation,</text><text class="s" x="446" y="144">vault, monitoring</text>
<path class="line" d="M505 168v40"/>
<rect class="box" x="430" y="208" width="150" height="56" rx="8"/><text class="t" x="446" y="232">PostgreSQL</text><text class="s" x="446" y="250">Everything you store</text>
<path class="line dash" d="M505 264v26h-120"/>
<rect class="box" x="230" y="270" width="155" height="48" rx="8"/><text class="t" x="246" y="291">Nightly backups</text><text class="s" x="246" y="308">Encrypted .atlasbak</text>
<path class="line dash" d="M580 104h40M580 124h40M580 144h40"/>
<rect class="box" x="620" y="20" width="160" height="48" rx="8"/><text class="t" x="634" y="41">ConnectWise</text><text class="s" x="634" y="58">Devices, tickets</text>
<rect class="box" x="620" y="80" width="160" height="48" rx="8"/><text class="t" x="634" y="101">Microsoft 365</text><text class="s" x="634" y="118">Users, licences</text>
<rect class="box" x="620" y="140" width="160" height="48" rx="8"/><text class="t" x="634" y="161">Vendors, registries</text><text class="s" x="634" y="178">Warranty, domain, SSL</text>
<path class="line dash" d="M620 44h-20v100M620 104h-20M620 164h-20"/>
</svg>
</div>
<p class="caption">Everyone reaches Atlas over HTTPS through the web proxy on the same server. Dashed lines are connections Atlas makes itself, on a schedule.</p>

## The parts

| Part | What it does |
|---|---|
| **Atlas** | The application. One service that serves the web pages and the API, runs scheduled jobs (syncs, checks, backups, alerts), and holds the vault key while it runs. |
| **PostgreSQL** | The database. Every client, asset, document, password and log entry is stored here. Passwords and other secrets are encrypted before they reach it. |
| **Web proxy** | Caddy on Linux installs. It serves Atlas over HTTPS and keeps its certificate up to date. |
| **The master key** | A key kept outside the database. It protects the vault key and every backup. Without it, encrypted data can't be read, so the person who runs the server keeps a copy offline. |
| **The updater** | A small helper on Linux installs. It installs new releases and carries out restarts and repairs when an administrator asks from the web page. |

## What a client workspace holds

Every client you support gets a workspace. Its tabs are the same for every client:

| Tab | What goes there |
|---|---|
| **Overview** | The client at a glance: primary contact, hours, maintenance window, asset counts, warranty, device health, security, trackers, tickets and recent activity. |
| **Assets** | Servers, workstations, firewalls, switches, domains, SSL certificates, licences and anything else, each in a layout with its own fields. |
| **Documents** | Runbooks, procedures and notes for this client. |
| **Passwords** | The client's vault: logins, secure notes, one-time codes and BitLocker keys. |
| **Contacts** and **Locations** | The people you deal with and the sites you visit. |
| **Checklists** | Onboarding, offboarding and maintenance procedures worked through step by step. |
| **Map** | How the client's assets, passwords, documents, contacts and locations link together. |
| **Activity** | Every change, by whom and when. |
| **Trackers** | Domain and SSL certificate expiry for the client's websites. |

## Where your data comes from

You can type everything in, but most teams start by bringing it in:

- **Hudu** companies, layouts, assets, articles, passwords, processes and relations import in one run, and running it again updates rather than duplicates.
- **Spreadsheets** (CSV) bring in clients, contacts, locations, assets and passwords.
- **ConnectWise RMM** keeps devices, their health and their tickets up to date every hour.
- **Microsoft 365** turns each client's tenant into contacts, licences and domains.
- **Vendors** fill in warranty dates for Dell, Lenovo and HP devices, and domain registries and websites fill in expiry dates for domains and certificates.

Chapter 12, [Data and integrations](integrations.html), explains each one.

## Who sees what

Atlas decides everything by role and by client. A technician sees only the clients they have been given, and a client they can't open looks the same as one that doesn't exist. Passwords need a higher level of access than documentation. Client accounts see only their own organization. [Getting started](getting-started.html#what-you-can-do-depends-on-your-role) has the full table.
