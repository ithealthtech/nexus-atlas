import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.E2E_PORT ?? 4399);
export const E2E = {
  // "localhost" rather than 127.0.0.1: passkeys (WebAuthn) need a host name, not an IP address.
  baseURL: `http://localhost:${port}`,
  setupCode: 'e2e-setup-code-0123456789',
  databaseUrl: process.env.E2E_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5432/atlas_e2e',
};

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: E2E.baseURL,
    trace: 'retain-on-failure',
    // Animations are disabled so accessibility checks measure final colours, not mid-fade ones.
    contextOptions: { reducedMotion: 'reduce' },
    screenshot: 'only-on-failure',
    // Use a preinstalled Chromium when one is provided (for example, in a container without downloads).
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {},
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    // Reset the database first so every run exercises first-run setup.
    command: 'node e2e/reset-db.mjs && node apps/server/dist/index.js',
    url: `${E2E.baseURL}/readyz`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      DATABASE_URL: E2E.databaseUrl,
      HOST: 'localhost',
      PORT: String(port),
      PUBLIC_URL: E2E.baseURL,
      ATLAS_SETUP_CODE: E2E.setupCode,
      ATLAS_DATA_DIR: 'test-results/e2e-data',
      LOG_LEVEL: 'warn',
    },
  },
});
