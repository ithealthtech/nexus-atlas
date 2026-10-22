import { defineConfig, devices } from '@playwright/test';

// The accessibility sweep and screenshot comparisons run against the clickable demo: the real app with its sample
// backend in the browser, so every page has data and nothing depends on a server or the clock.
// Build it first: npm run build:demo -w @atlas/web
const port = Number(process.env.DEMO_PORT ?? 4398);

export default defineConfig({
  testDir: 'e2e/demo',
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never', outputFolder: 'playwright-report-demo' }]] : 'list',
  outputDir: 'test-results/demo',
  // One set of reference screenshots, taken on Linux in CI; fonts render differently elsewhere.
  snapshotPathTemplate: '{testDir}/screenshots/{arg}{ext}',
  // A missing reference image is written (and that run fails once), so CI makes a new or deleted one.
  updateSnapshots: 'missing',
  expect: { toHaveScreenshot: { maxDiffPixelRatio: 0.01, animations: 'disabled', caret: 'hide' } },
  use: {
    baseURL: `http://localhost:${port}`,
    contextOptions: { reducedMotion: 'reduce' },
    timezoneId: 'UTC',
    locale: 'en-US',
    trace: 'retain-on-failure',
    // A local run can use an installed browser instead of Playwright's: PLAYWRIGHT_CHANNEL=msedge.
    ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}),
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `npx vite preview --config vite.demo.config.ts --mode demo --strictPort --port ${port}`,
    cwd: 'apps/web',
    url: `http://localhost:${port}/`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
