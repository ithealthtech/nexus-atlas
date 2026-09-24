# Verification log

## M3b Data in and out — September 24, 2026

Run on Node 22 and PostgreSQL 16 in a Linux container.

- **Integration tests:** `npm test` passes all **54 tests in 7 files**. The 9 new ones in `data.test.ts` cover:
  - **API keys:** a key is shown once and stored as a hash. Scopes are enforced, the passwords scope is needed for the vault, and account and settings endpoints are closed to keys. Revoked keys get 401. Actions are recorded under the key's name.
  - **OpenAPI:** `/api/openapi.json` describes the documented paths.
  - **Hudu:** tested against a fake Hudu with 26 companies, so pagination runs. It covers layouts, assets, HTML articles (with unsafe links removed), and passwords flattened into client vaults. A second run updates instead of duplicating. A rejected key reports a clear error.
  - **CSV:** a dry run saves nothing and reports row numbers. Imports of clients, contacts, assets, and passwords are covered, and password imports need vault access.
  - **Export:** the zip holds client.json, documents, and attachments. Decrypted passwords are included only for administrators who have just confirmed their password.
  - **Client portal:** a client account sees only shared, unrestricted passwords.
  - **0.2 migration:** a sample 0.2 database moves over clients, records, relationships, users with their passwords, and grants.
- **Browser tests:** `npm run test:e2e` passes all **14 tests** with no axe (WCAG 2.2 AA) violations. The new ones cover:
  - CSV import with column matching and a dry run, API key creation, and branding (the accent colour applies).
  - A client export download.
  - A client contact revealing a shared password, including the client's required reason.
- **Issues found and fixed during M3b verification:**
  - Client viewers could see password names in a client's activity feed. Existed before M3b.
  - The rich-text editor could move the cursor while typing, because its options were rebuilt on every render. This was also the cause of an intermittently failing runbook test.
  - A Hudu article with a `javascript:` link failed to import as a whole. Unsafe links are now dropped and their text kept.
  - CSV headers such as "Client Name" weren't matched automatically.
- **Also run:** lint, typecheck, legacy 0.2 tests, and `npm audit --omit=dev`.

## M3a Accounts and security — September 24, 2026

Run on Node 22 and PostgreSQL 16 in a Linux container.

- **Integration tests:** `npm test` passes all **45 tests in 6 files**. The 14 new ones in `security.test.ts` cover:
  - **Recovery codes:** 10 unique codes, stored only as hashes; each works once (reuse and made-up codes get 400); replacing them needs a recent password confirmation and invalidates the old set.
  - **Remembered browsers and sessions:** a remembered browser skips the second step; a forged device cookie does not. Sessions can be listed (no token hashes exposed) and ended one at a time or all at once; forgetting the browser brings the second step back.
  - **Passkeys:** registration and sign-in are exercised with a software authenticator (ES256). A response for the wrong challenge or from another origin is rejected. Passwordless sign-in requires user verification and each challenge works once. Removal needs a recent password confirmation. Staff can enroll a passkey instead of an app, and an admin MFA reset removes passkeys.
  - **Email:** the SMTP password is never stored or logged in plaintext; saving without a password keeps it; test sends report the server's rejection. Only admins with a recent password confirmation can change settings.
  - **Password reset:** nothing is sent when email is off or the account is unknown; the link works once, rejects weak passwords, signs the person out everywhere, and MFA still applies afterwards.
  - **Groups:** group grants give client access; restricted passwords open to listed groups only; client accounts can't join; duplicate names get 409; deleting a group removes access.
  - **Expirations and alerts:** only items within the window and visible to the person are listed; alert emails go out once per day and the digest on Mondays.
  - **Audit log:** a clean chain verifies; normal SQL can't edit rows; an edited row (triggers disabled) is pinpointed; deleting the newest row fails the signed checkpoint; 30 concurrent writers leave the chain intact; CSV cells can't run as formulas.
- **Browser tests:** `npm run test:e2e` passes all **12 tests** with no axe (WCAG 2.2 AA) violations. The 3 new ones cover signing in with a recovery code and remembering the browser; adding a passkey with Chrome's virtual authenticator and signing in with it alone; and Microsoft 365 email settings, groups, expirations, log verification, and the forgot-password page. The e2e server now runs on `localhost` because passkeys need a host name.
- **Issues found and fixed during M3a verification:**
  - Signing out left the workspace on screen until a reload (the whole query cache was cleared, detaching the session query). Existed before M3a.
  - Concurrent security events could take IDs out of chain order; the ID is now assigned after the chain lock.
  - Log verification sorted event IDs as text, so logs with 10 or more events reported a false break.
- **Also run:** lint, typecheck, legacy 0.2 tests, and `npm audit --omit=dev` (0 vulnerabilities).

## M2 Password vault — September 24, 2026

Run on Node 22 and PostgreSQL 16 in a Linux container.

- **Integration tests:** `npm test` passes all **31 tests in 5 files**. The 7 new ones in `vault.test.ts` cover:
  - **No plaintext:** a full dump of `passwords`, `vault_keys`, `vault_audit`, and `activity` contains no secret, TOTP key, or note.
  - **Reveals:** password, notes, and TOTP (checked against the live code) reveal correctly, and copies and views are audited in order.
  - **History and reuse:** changing a password keeps the previous one, which can be revealed; editing details doesn't reset the rotation clock; stale edits get 409; reuse across clients is flagged and clears after a change; archiving works.
  - **Access:**
    - "Edit" access without passwords gets 404, 403 on listing, and nothing in search.
    - Client viewers see nothing.
    - Only admins can restrict an entry; a restricted entry disappears for everyone not listed, including from search, until they're added.
    - The organization-wide vault audit is admin-only.
  - **Reasons:** a client setting makes a reason mandatory (400 with `reason_required`), and the reason is stored.
  - **BitLocker and TOTP:** recovery-key format and TOTP keys are validated. A BitLocker key links to an asset, and the link is hidden from people without vault access. Files can't be attached to vault entries.
  - **Share links:** only ciphertext and a token hash are stored. Two simultaneous opens of a one-view link give exactly one 200 and one 404. Revoked and expired links fail, and opens are audited.
  - **Key re-wrap:** data keys are re-wrapped under a new master key and data still decrypts; the old master key no longer works.
- **Other issues found and fixed during M2 verification:**
  - The access history didn't refresh after a reveal.
  - The logo's small text had low contrast on light pages.
  - The share page used invalid list markup.
  - A timing race in the editor test (the cursor wasn't placed before typing).
- **Regression found and fixed:** update requests reset every field they didn't mention. This affected clients, assets, documents, contacts, and locations, because zod's `.partial()` keeps default values. A new `patchOf()` helper builds update schemas without defaults, and a test now covers a partial client update.
- **Browser tests:** `npm run test:e2e` passes all **9 Playwright tests**. The vault flow covers:
  - Generate a password and see the strength meter; save with a TOTP key; reveal, copy (clipboard checked), and show the one-time code.
  - Change the password and see it appear in the history.
  - Create a one-time share link and open it in a separate browser with no account. The key is removed from the address bar, the password decrypts, and a second open is refused.
  - Turn on "require a reason" for the client, reveal with a reason, and see it in the access history.
  - Validate a BitLocker key.
  - The client viewer has no Passwords navigation or tab.
  - axe checks the vault form, detail page, and share page.


## M1 Documentation — September 23, 2026

Run on Node 22 and PostgreSQL 16 in a Linux container.

- **Integration tests:** `npm test` passes all **24 tests in 4 files**. The 9 new ones in `docs.test.ts` cover:
  - **Rich text:** the sanitizer keeps allowed formatting, strips unknown attributes, rejects script-like nodes and `javascript:` or protocol-relative links, and extracts text including checklist state. Prefix queries are built correctly.
  - **Layouts:** 13 built-ins are seeded. Only admins can create layouts, and choice fields with no options or duplicate keys are rejected.
  - **Asset fields:** IP, choice, required, and URL fields are validated with field-level errors, and unknown fields are dropped.
  - **Versions:** stale edits get 409, revisions list and restore work, archiving works.
  - **Access:**
    - Client viewers can't see other clients' assets, documents, or contacts, or the MSP knowledge base, and can't edit.
    - Read-only technicians can't write to the MSP knowledge base.
    - Restricted technicians can't create documents in other clients.
    - Activity is scoped per client.
  - **Documents:** conflicts and restore behave as for assets; folders must belong to the same client; deleting a folder moves its documents to the top level.
  - **Relationships:** duplicate links are stored once, links are symmetric, cross-client and self links are refused, an MSP article can link to a client asset, a viewer doesn't see the MSP-internal link, and unlinking needs edit access.
  - **Attachments:**
    - Path components are stripped from filenames.
    - HTML is stored as octet-stream and always downloads, with a sandbox CSP.
    - A real PNG displays inline; oversized (413) and empty files are refused.
    - Viewers can download but not upload or delete, and other clients get 404.
  - **Search:** finds assets by name prefix and IP, documents by body text with snippets, contacts, and clients; limits results to the viewer's access; and treats SQL-looking input as plain text.
- **Browser tests:** `npm run test:e2e` passes all **7 Playwright tests**:
  - Asset from the Configurations template, including a bad IP rejected in the form, an edit, and a version comparison showing the added serial number.
  - File upload.
  - Runbook from a template, edited in the rich-text editor, linked to the firewall, found with Ctrl+K by body text and by IP.
  - Custom layout with a choice field.
  - MSP knowledge-base article.
  - The client viewer sees the asset and the linked runbook read-only; has no upload, edit, or knowledge base; and search hides MSP articles.
  - axe finds **0 WCAG 2.2 AA violations** on every checked screen, including the editor and the diff dialog, and there are no console or CSP errors.

**Issues found and fixed during M1 verification:**

- Per-field validation errors weren't sent to the browser.
- An oversized upload was silently cut off and saved; it's now rejected.
- The global security headers overwrote the sandbox CSP on file downloads.
- The Postgres array parameter for client IDs was malformed.
- Checklist state was missing from the text used for search and diffs.
- The read-only document view was exposed as an unlabelled text box.
- Checklist checkboxes were below the WCAG 2.2 minimum target size.
- The diff dialog fetched data during render.
- The rich-text editor made the initial bundle too large, so it's now code-split (215 KB gzipped initially).


## M0 Foundation — September 23, 2026

Run on Node 22 and PostgreSQL 16 in a Linux container.

- **Lint and format:** `npm run lint` is clean and `prettier --check` passes.
- **Types:** `npm run typecheck` passes for shared, db, server, and web.
- **Unit and integration tests:** `npm test` passes all **15 tests in 3 files**, against real PostgreSQL with a fresh database per test.
  - **Crypto and configuration:**
    - Round trip; a value moved to another row or tampered with fails.
    - Old keys still decrypt after rotation, and a missing key is named in the error.
    - The key file is created with mode 0600.
    - Unsafe production settings stop startup.
  - **Identity:**
    - Setup needs the code and works only once; MFA is required and the pending key is reused on reload.
    - MFA secrets are sealed and no plaintext password is stored.
    - Codes can't be replayed, and email matching ignores case.
    - Lockout blocks even the correct password.
    - CSRF, Origin, and Host checks work; forged identity headers and fake cookies are rejected; the vault stays closed (501); `/readyz` reports healthy.
  - **Access:**
    - Grant validation: at least one client, same organization, within the role's cap, unique email.
    - Client viewers are read-only and other clients look missing.
    - Restricted technicians can edit only granted clients.
    - Raising the baseline, demoting, and disabling all apply to live sessions.
    - Group grants work.
    - Resetting signs the user out and clears MFA.
    - Owner protections hold.
- **Browser tests:** `npm run test:e2e` passes all **4 Playwright tests** with Chromium:
  - First-run setup (including a wrong code), then MFA enrollment by QR code or key.
  - The owner creates clients and a client viewer; the security log shows the events.
  - The viewer replaces the temporary password and sees only Harbor Dental, read-only, with the admin pages blocked.
  - Dark mode at phone width with no horizontal scrolling.
  - axe finds **no WCAG 2.2 AA violations** on the checked pages, in both themes.
  - No console errors or CSP violations.
- **Docker:** the image builds (403 MB) and runs as the non-root `node` user. In production mode it migrates on start and prints the setup code. `/readyz` returns 200, a foreign Host gets 403, client-side routes serve `index.html` with CSP and HSTS, and `PUBLIC_URL=http://…` is refused.
- **Dependencies:** `npm audit --omit=dev` reports 0 vulnerabilities. Moderate advisories remain in dev-only tooling (esbuild, used by drizzle-kit).
- **Legacy:** the 0.2 suite, now in `legacy/`, still passes 16 of 16.

**Issues found and fixed during M0 verification:**

- A PostgreSQL connection dropped by the server crashed the process. Pool errors are now handled.
- A wrong MFA code cleared the session cookie. It now returns 400 and only an invalid session clears the cookie.
- The client-ID array query was malformed.
- Form error handling crashed after an `await` in React.
- Muted text and status badges had colour contrast below AA.
- Admin pages showed endless loading skeletons to non-admins. There's now a guard, and 4xx responses aren't retried.

**Not yet verified:**

- The Windows CI job, and the GitHub-hosted runs in general. They're defined, but have only run in this container.
- `docker compose` with Caddy obtaining a real certificate. The Compose file was written but not run here, because Docker Hub was rate-limited.
- A real phone authenticator app. Codes were generated with the RFC 6238 implementation, which is checked against the published test vector.

## Earlier: 0.1 and 0.2 prototypes

The original local prototype checks are preserved in git history. The 0.2 suite still runs with `npm run legacy:test`.
