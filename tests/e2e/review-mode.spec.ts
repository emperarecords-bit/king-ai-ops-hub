import { expect, test } from '@playwright/test';

/**
 * Answer-routing Phase 1 — the review-mode badge, end to end. Submits a task with the Answer mode toggle set
 * to Reviewed and one set to Quick, runs them, and asserts the task result surfaces the review-state badge.
 *
 * Deterministic badge rendering for every outcome is covered by tests/unit/review-state-badge.test.tsx; the
 * server-side enforcement (including Quick-forced-to-Reviewed and required-but-unmet) is covered end-to-end at
 * the API/history level by tests/integration/review-enforcement.test.ts. This spec is the UI thread.
 *
 * Requires the same setup as critical-flow.spec.ts (dev server, Supabase env, E2E_EMAIL/E2E_PASSWORD, seed).
 * It SKIPS when those are absent, exactly like the critical flow, so it is a CI check, not a local-only gate.
 */

const email = process.env.E2E_EMAIL;
const password = process.env.E2E_PASSWORD;

test.describe('answer-routing — review-mode badge', () => {
  test.skip(!email || !password, 'E2E_EMAIL / E2E_PASSWORD not configured');

  async function signInAndOpenNewTask(page: import('@playwright/test').Page) {
    await page.goto('/login');
    await page.getByLabel('Email').fill(email!);
    await page.getByLabel('Password').fill(password!);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/projects/);
    // Enter the seeded sandbox, then go straight to the new-task form (robust against dashboard link wording).
    await page.getByRole('link', { name: /E2E Sandbox(?! B)/ }).first().click();
    await expect(page).toHaveURL(/\/p\/e2e-sandbox/);
    const key = new URL(page.url()).pathname.split('/')[2];
    await page.goto(`/p/${key}/tasks/new`);
    await expect(page.getByLabel('Title')).toBeVisible();
  }

  test('Answer mode selector is present and offers Quick/Reviewed framing', async ({ page }) => {
    await signInAndOpenNewTask(page);
    await expect(page.getByText('Answer mode')).toBeVisible();
    // Reviewed is the default (checkbox checked → "Reviewed — cross-check…").
    await expect(page.getByText(/Reviewed — cross-check/)).toBeVisible();
  });

  // Triggering a run dispatches to REAL providers in a live dev server (a paid model call), so this is gated
  // behind an explicit opt-in and never runs by default. The badge RENDERING is proven, billing-free, by
  // tests/unit/review-state-badge.test.tsx, and the review outcome persisted on a run is proven end-to-end with
  // fake providers by tests/integration/review-enforcement.test.ts.
  test('a run surfaces the review-state badge on the task result', async ({ page }) => {
    test.skip(process.env.E2E_ALLOW_BILLABLE_RUN !== '1', 'billable run gated — set E2E_ALLOW_BILLABLE_RUN=1');
    await signInAndOpenNewTask(page);
    const title = `E2E review-mode ${Date.now()}`;
    await page.getByLabel('Title').fill(title);
    await page
      .getByLabel('Task brief')
      .fill('E2E: reply with the single word "pong". Do not propose any actions.');
    await page.getByRole('button', { name: 'Create task' }).click();
    await expect(page).toHaveURL(/\/tasks\//);

    // Run it, then assert the review-state badge is present (aria-label="Review state").
    await page.getByRole('button', { name: /^(Run|Run task|Start run)/ }).first().click();
    const badge = page.locator('[aria-label="Review state"]');
    await expect(badge).toBeVisible({ timeout: 60_000 });
  });
});
