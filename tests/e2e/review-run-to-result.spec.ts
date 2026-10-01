import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

/**
 * Answer-routing Phase 1 — BROWSER run-to-result in the actual LOCAL app, billing-free. Each case runs a real
 * run through the dev server with the fenced in-app FAKE providers (HUB_TEST_FAKE_PROVIDERS=1), then asserts
 * the VISIBLE badge/banner. The paired PERSISTED state (runs.review_outcome) is dumped by the accompanying
 * psql step keyed on the same task ids (this spec can't import server-only DB code).
 *
 * HARD billing guard: skips unless HUB_TEST_FAKE_PROVIDERS=1, so it can never trigger a paid provider call.
 * Tasks are seeded by scripts/e2e-seed-review-tasks.ts, whose ids are written to $RTR_IDS_FILE.
 */

const email = process.env.E2E_EMAIL;
const password = process.env.E2E_PASSWORD;
const fakesOn = process.env.HUB_TEST_FAKE_PROVIDERS === '1';
const idsFile = process.env.RTR_IDS_FILE;

type Ids = { projectKey: string; quick: string; reviewed: string; forcedFail: string };
const ids: Ids | null = idsFile ? (JSON.parse(readFileSync(idsFile, 'utf8')) as Ids) : null;

test.describe('answer-routing — browser run-to-result (in-app fakes)', () => {
  test.skip(!email || !password, 'E2E creds not configured');
  test.skip(!fakesOn, 'HUB_TEST_FAKE_PROVIDERS!=1 — refusing to run (would make paid calls)');
  test.skip(!ids, 'RTR_IDS_FILE not provided — run scripts/e2e-seed-review-tasks.ts first');

  async function signIn(page: Page) {
    await page.goto('/login');
    await page.getByLabel('Email').fill(email!);
    await page.getByLabel('Password').fill(password!);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/projects/);
  }

  async function runTask(page: Page, taskId: string) {
    await signIn(page);
    // ?autorun=1 auto-fires the run for a pending task; the run streams then the page refreshes to the truth.
    await page.goto(`/p/${ids!.projectKey}/tasks/${taskId}?autorun=1`);
  }

  test('allowed Quick (exempt) → omitted badge, no banner', async ({ page }) => {
    await runTask(page, ids!.quick);
    const badge = page.locator('[aria-label="Review state"]');
    await expect(badge).toContainText('review not required', { timeout: 90_000 });
    await expect(page.getByText('UNREVIEWED DRAFT')).toHaveCount(0);
  });

  test('Reviewed → reviewed badge', async ({ page }) => {
    await runTask(page, ids!.reviewed);
    const badge = page.locator('[aria-label="Review state"]');
    await expect(badge).toContainText('Reviewed', { timeout: 90_000 });
    await expect(page.getByText('UNREVIEWED DRAFT')).toHaveCount(0);
  });

  test('forced Reviewed + reviewer failure → required_unmet badge AND unreviewed-draft banner', async ({ page }) => {
    await runTask(page, ids!.forcedFail);
    const badge = page.locator('[aria-label="Review state"]');
    await expect(badge).toContainText('Unreviewed draft', { timeout: 90_000 });
    // The banner travels with the ANSWER itself (its phrasing differs from the badge, disambiguating the two).
    await expect(page.getByText('a required review did not complete')).toBeVisible();
  });
});
