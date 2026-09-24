# Data in and out

Everything on this page is under **Import & export** (administrators) and **Settings** in the app.

## REST API

- **Address:** `https://<atlas>/api/v1/…`, using the same paths as the web app without the `/api` prefix (for example `GET /api/v1/clients`). The OpenAPI 3.1 description is at `/api/openapi.json`.
- **API keys:** administrators create them under **Settings → API keys**, which needs a recent password confirmation. A key is shown once. It looks like `atlas_<prefix>_<secret>`, and only its SHA-256 hash is stored. Send it as `Authorization: Bearer <key>`.
- **Scopes:**
  - `read` allows GET requests.
  - `write` allows changes.
  - `passwords` is needed for any vault endpoint, including reveals.
- **What a key can reach:** clients, assets, documents, folders, contacts, locations, layouts, relationships, search, activity, expirations, and (with `passwords`) the vault. Account, people, settings, and log endpoints are closed to keys.
- **Permissions:** a key acts as the administrator who created it. It stops working if that person is disabled, and it can expire (365 days by default, or never).
- **Records:** everything a key does is recorded under that person's name with "(API key: *name*)". Creation and revocation go into the security log.
- **Limits:** each key can make 600 requests a minute.

```bash
curl -H "Authorization: Bearer $ATLAS_KEY" https://atlas.example.com/api/v1/clients
```

## Import from Hudu

1. In Hudu, go to **Admin → API Keys** and create a key. A key without password access imports everything except passwords.
2. In Atlas, open **Import & export → Hudu**. Enter the Hudu address (https only) and the key, then choose **Connect**. The key is encrypted with the master key. **Forget** removes it.
3. **Preview** counts what Hudu has. **Start import** runs the import in the background; the page shows progress and a summary per type.

| Hudu | Atlas |
|---|---|
| Companies | Clients. The address, phone, and website become a "Main office" location. |
| Asset layouts | Layouts. Password and confidential-text fields are left out, dropdowns become text, and other field types map directly. |
| Assets | Assets under the matching client and layout. The manufacturer, model, and serial number go into notes. A value that doesn't fit its field is kept in notes rather than lost. |
| Knowledge base articles | Documents. Company articles go to that client and global articles to the internal knowledge base. HTML is converted to the Atlas editor, and scripts and unsafe links are removed. |
| Passwords | Vault entries in the client's passwords, as a flat list (folders aren't kept), including one-time code keys. Passwords that aren't tied to a company are skipped and listed in the summary. |

- **Running it again is safe.** Atlas remembers which Hudu item became which Atlas record, and updates those records instead of creating duplicates. If a record was deleted in Atlas, it is created again. Each update is a new version, so earlier edits can be compared or restored.
- **Archived items** in Hudu are skipped.
- **One import at a time:** only one import can run at once. Each run, with the problems it hit, is kept in the import history.

## CSV import

**Import & export → CSV** imports clients, contacts, locations, assets (into a chosen layout), or passwords.

- **Files:** comma, semicolon, or tab separated, up to 10 MB, with a header row.
- **Column matching:** Atlas matches columns by name, including common alternatives such as "Client Name" or "Company". Any column can be reassigned before importing.
- **Check the file first:** this dry run validates every row, reports each problem with its row number, and saves nothing. **Import** is available once the check has run.
- **Matching rows:** rows go to clients by name. A client that already exists is updated with the non-empty columns in the file; everything else about it, including whether reveals need a reason, is kept.
- **Passwords:** importing passwords needs "Edit + passwords" on each client involved. The import is recorded in the security log.

## Exporting a client

Staff can choose **Export** on a client to download a zip of everything they can see there:

- `client.json`: the client, contacts, locations, assets with their fields, documents, and relationships, in format `msp-atlas-export` v1.
- The documents as plain text.
- The attachments.

Administrators can add **decrypted passwords**. This needs a recent password confirmation, and every export is recorded, noting whether passwords were included. Keep such exports encrypted and delete them when you're done.

## Moving from the 0.2 prototype

The 0.2 prototype stored everything in one SQLite file. Run this once against a new or existing Atlas database:

```bash
npm run migrate-legacy -w @atlas/server -- /path/to/atlas.sqlite [--legacy-key /path/to/0.2/master.key] [--owner you@example.com] [--workspace msp-demo]
```

- **What moves:** clients and their contacts. Records become assets in the Configurations layout, or documents. Relationships move with them.
- **People:** users keep their passwords (same scrypt format) and client grants.
- **Two-step verification:** authenticator apps carry over only when the 0.2 key file is given; otherwise those people set up two-step verification again.
- **One workspace per run:** a 0.2 file can hold several workspaces. Atlas migrates the only one with user accounts, and otherwise stops and lists them so you can choose one with `--workspace`.
- **Safe to repeat:** running it again skips what was already migrated.

## Branding and the client portal

- **Branding:** **Settings → Branding** sets a logo (up to 150 KB), an accent colour (text on it switches between light and dark to stay readable), and a welcome message that client accounts see on their dashboard.
- **Client portal:** client accounts (Client editor and Client viewer) sign in to the same address and see only their own clients.
  - **Passwords:** they can't see the vault unless a technician ticks **Share with the client's own accounts** on an entry. Shared entries are read-only for them.
  - **Rules still apply:** reveals are recorded in the access history, and the client's "require a reason" setting applies to them too. Restricted entries are never shared.
  - **Activity:** the feed doesn't show password changes to people who can't open the vault.
