import { expect, test, type Page } from '@playwright/test';

/**
 * Documents Detail — authenticated MOBILE acceptance (P2 Blocker 1). Signs in as the E2E owner, opens
 * seeded `__pf-demo-` Detail fixtures at a real 390×844 viewport, captures current / historical / unavailable
 * screenshots, and asserts there is no page-level horizontal overflow (tables scroll inside their own
 * container). Requires the `__pf-demo-` matrix seeded into the e2e-sandbox project:
 *   SEED_PROJECT_KEY=e2e-sandbox npm run seed:portfolio-states
 */

const email = process.env.E2E_EMAIL;
const password = process.env.E2E_PASSWORD;
const SHOT_DIR = 'tests/e2e/__screenshots__';

test.use({ viewport: { width: 390, height: 844 } });

test.describe('documents detail — mobile', () => {
  test.skip(!email || !password, 'E2E_EMAIL / E2E_PASSWORD not configured');

  async function signIn(page: Page) {
    await page.goto('/login');
    await page.getByLabel('Email').fill(email!);
    await page.getByLabel('Password').fill(password!);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForURL(/\/projects|\/p\//);
  }

  async function assertNoHorizontalOverflow(page: Page) {
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, 'page-level horizontal overflow (px)').toBeLessThanOrEqual(1);
  }

  test('current, historical, and unavailable versions render cleanly at 390×844', async ({ page }) => {
    await signIn(page);

    // --- Current version ---------------------------------------------------
    await page.goto('/p/e2e-sandbox/documents');
    await page.getByRole('link', { name: '__pf-demo-supplied-to-ai.md' }).click();
    await expect(page.getByRole('heading', { name: '__pf-demo-supplied-to-ai.md' })).toBeVisible();
    await expect(page.getByText('Current version').first()).toBeVisible();
    await expect(page.getByText('Download exact source')).toBeVisible(); // control reachable
    await assertNoHorizontalOverflow(page);
    await page.screenshot({ path: `${SHOT_DIR}/detail-mobile-current.png`, fullPage: true });

    // --- Historical version (select the older version in Version history) ---
    await page.goto('/p/e2e-sandbox/documents');
    await page.getByRole('link', { name: '__pf-demo-available-multiple-versions.md' }).click();
    await page.getByRole('link', { name: 'Inspect' }).first().click();
    await expect(page.getByText(/inspecting a historical version/)).toBeVisible();
    await expect(page.getByText('Historical version').first()).toBeVisible();
    await assertNoHorizontalOverflow(page);
    await page.screenshot({ path: `${SHOT_DIR}/detail-mobile-historical.png`, fullPage: true });

    // --- Unavailable version -----------------------------------------------
    await page.goto('/p/e2e-sandbox/documents');
    await page.getByRole('link', { name: '__pf-demo-source-disconnected.md' }).click();
    await page.getByRole('link', { name: 'Inspect' }).first().click();
    await expect(page.getByText(/Source content is unavailable/).first()).toBeVisible();
    await expect(page.getByText('Download exact source')).toHaveCount(0); // no download control for unavailable
    await assertNoHorizontalOverflow(page);
    await page.screenshot({ path: `${SHOT_DIR}/detail-mobile-unavailable.png`, fullPage: true });
  });
});
