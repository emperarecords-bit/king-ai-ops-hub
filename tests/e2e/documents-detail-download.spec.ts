import { expect, test } from '@playwright/test';

/**
 * Documents Detail — restricted DOWNLOAD is release-safe (P2 final blocker). Authenticated, against the
 * seeded `__pf-demo-` matrix in e2e-sandbox. Proves a directly-constructed or replayed GET to the restricted
 * download URL returns NO bytes, that the deliberate POST returns the exact bytes, and that non-restricted
 * GET download still works.
 *   SEED_PROJECT_KEY=e2e-sandbox npm run seed:portfolio-states
 */

const email = process.env.E2E_EMAIL;
const password = process.env.E2E_PASSWORD;
const base = process.env.APP_URL ?? 'http://localhost:3000';

test.describe('documents detail — restricted download', () => {
  test.skip(!email || !password, 'E2E_EMAIL / E2E_PASSWORD not configured');

  async function signIn(page: import('@playwright/test').Page) {
    await page.goto('/login');
    await page.getByLabel('Email').fill(email!);
    await page.getByLabel('Password').fill(password!);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForURL(/\/projects|\/p\//);
  }

  async function openFixture(page: import('@playwright/test').Page, name: string): Promise<string> {
    await page.goto('/p/e2e-sandbox/documents');
    await page.getByRole('link', { name }).click();
    await page.waitForURL(/\/documents\/[0-9a-f-]{36}/);
    return page.url();
  }

  test('a GET cannot release restricted bytes; the deliberate POST can', async ({ page }) => {
    await signIn(page);

    // Restricted source — read the exact versionId from the reveal form WITHOUT revealing anything.
    const detailUrl = await openFixture(page, '__pf-demo-available-restricted.md');
    const documentId = detailUrl.match(/documents\/([0-9a-f-]{36})/)![1];
    await expect(page.getByRole('button', { name: 'Reveal restricted content' })).toBeVisible(); // no content pre-reveal
    const versionId = await page.locator('input[name="versionId"]').first().inputValue();
    const downloadUrl = `${base}/p/e2e-sandbox/documents/${documentId}/download?version=${versionId}`;

    // 1. A direct / replayed GET to the restricted download URL returns NO bytes (bounded 404).
    const getResp = await page.request.get(downloadUrl);
    expect(getResp.status(), 'direct GET to restricted download').toBe(404);
    expect(getResp.headers()['content-disposition']).toBeUndefined();
    const getBody = await getResp.body();
    expect(getBody.toString('utf8')).not.toContain('Sensitive demo body');

    // A second GET (replay) still releases nothing.
    expect((await page.request.get(downloadUrl)).status()).toBe(404);

    // 2. The deliberate, same-origin POST releases the exact bytes, private + no-store, safe filename.
    const postResp = await page.request.post(downloadUrl, { headers: { origin: base } });
    expect(postResp.status(), 'deliberate POST download').toBe(200);
    expect(postResp.headers()['content-disposition']).toContain('attachment; filename="__pf-demo-available-restricted.md"');
    expect(postResp.headers()['cache-control']).toContain('no-store');
    expect((await postResp.body()).toString('utf8')).toContain('Sensitive demo body');

    // 3. A cross-origin POST is rejected (CSRF/origin guard).
    const crossResp = await page.request.post(downloadUrl, { headers: { origin: 'https://evil.example.com' } });
    expect(crossResp.status()).toBe(403);
  });

  test('a non-restricted byte-exact document still downloads over an authorized GET', async ({ page }) => {
    await signIn(page);
    await openFixture(page, '__pf-demo-available-byte-exact.md');
    // The inline (non-restricted) preview shows a GET download link.
    const href = await page.getByRole('link', { name: 'Download exact source' }).getAttribute('href');
    const getResp = await page.request.get(`${base}${href}`);
    expect(getResp.status()).toBe(200);
    expect(getResp.headers()['content-disposition']).toContain('attachment');
    expect((await getResp.body()).length).toBeGreaterThan(0);
  });
});
