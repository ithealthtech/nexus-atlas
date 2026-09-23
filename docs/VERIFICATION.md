# Verification log

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
