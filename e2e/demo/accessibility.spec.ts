import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { open, sampleIds, signIn } from './demo';

// Every page a technician or administrator can open, checked against WCAG 2.2 AA in both themes and at desktop and
// phone width. {client}, {asset}, {document} and {password} are filled in from the demo's sample data.
const PAGES = [
  '/',
  '/clients',
  '/clients/{client}',
  '/clients/{client}/assets',
  '/clients/{client}/documents',
  '/clients/{client}/passwords',
  '/clients/{client}/contacts',
  '/clients/{client}/locations',
  '/clients/{client}/checklists',
  '/clients/{client}/licenses',
  '/clients/{client}/reports',
  '/clients/{client}/map',
  '/clients/{client}/activity',
  '/clients/{client}/trackers/domains',
  '/clients/{client}/trackers/ssl',
  '/assets',
  '/assets/{asset}',
  '/assets/labels',
  '/documents',
  '/documents/{document}',
  '/documents/new',
  '/passwords',
  '/passwords/{password}',
  '/password-health',
  '/sends',
  '/my-vault',
  '/checklists',
  '/expirations',
  '/reports',
  '/account',
  '/admin/users',
  '/admin/groups',
  '/admin/layouts',
  '/admin/security',
  '/admin/vault-policies',
  '/admin/email',
  '/admin/alerting',
  '/admin/monitoring',
  '/admin/sign-in',
  '/admin/api-keys',
  '/admin/theme',
  '/admin/data',
  '/admin/rotation',
  '/admin/bitlocker',
  '/admin/duplicates',
  '/admin/status',
  '/admin/request-log',
  '/admin/webhooks',
  '/admin/updates',
  '/admin/services',
  '/admin/certificate',
  '/admin/remote-access',
];

const VIEWS = [
  { name: 'desktop', viewport: { width: 1440, height: 900 } },
  { name: 'phone', viewport: { width: 390, height: 844 } },
] as const;

for (const colorScheme of ['light', 'dark'] as const)
  for (const view of VIEWS)
    test.describe(`${colorScheme}, ${view.name}`, () => {
      test.use({ colorScheme, viewport: view.viewport });

      test('every page meets WCAG 2.2 AA', async ({ page }) => {
        test.setTimeout(240_000);
        const errors: string[] = [];
        page.on('pageerror', (e) => errors.push(e.message));
        await signIn(page);
        const ids = await sampleIds(page);
        const found: string[] = [];
        for (const template of PAGES) {
          const path = template.replace(/\{(\w+)\}/g, (_, key: keyof typeof ids) => ids[key]);
          await test.step(template, () => open(page, path));
          // On a phone, nothing may make the page scroll sideways.
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
          if (overflow > 0) found.push(`${template} scrolls sideways by ${overflow}px`);
          const { violations } = await new AxeBuilder({ page })
            .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
            // The demo's own "sample data" badge is not part of Atlas.
            .exclude('[data-demo-badge]')
            .analyze();
          for (const v of violations)
            found.push(
              `${template} ${v.id} (${v.impact}): ${v.nodes
                .slice(0, 3)
                .map((n) => `${n.target.join(' ')}: ${n.failureSummary?.split('\n').slice(1).join(' ').trim()}`)
                .join(' | ')}`,
            );
        }
        expect(found).toEqual([]);
        expect(errors).toEqual([]);
      });

      test('every form dialog meets WCAG 2.2 AA', async ({ page }) => {
        test.setTimeout(120_000);
        await signIn(page);
        const ids = await sampleIds(page);
        const found: string[] = [];
        for (const [path, button] of DIALOGS) {
          await open(page, path.replace('{client}', ids.client));
          await test.step(`${path}: ${button}`, async () => {
            await page.getByRole('button', { name: button }).first().click();
            await expect(page.getByRole('dialog')).toBeVisible();
          });
          const { violations } = await new AxeBuilder({ page })
            .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
            .include('dialog[open], [role="dialog"]')
            .analyze();
          for (const v of violations)
            found.push(`${path} ${button}: ${v.id} (${v.impact}) ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
          await page.keyboard.press('Escape');
          await expect(page.getByRole('dialog')).toHaveCount(0);
        }
        expect(found).toEqual([]);
      });
    });

// The forms people fill in most, each opened from its page.
const DIALOGS: [string, string][] = [
  ['/clients', 'Add client'],
  ['/clients/{client}/assets', 'Add asset'],
  ['/clients/{client}/passwords', 'Add password'],
  ['/clients/{client}/contacts', 'Add contact'],
  ['/clients/{client}/locations', 'Add location'],
  ['/admin/users', 'Add person'],
  ['/admin/api-keys', 'New key'],
  ['/documents', 'Template library'],
];
