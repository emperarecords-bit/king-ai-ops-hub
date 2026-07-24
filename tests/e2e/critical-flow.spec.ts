import { expect, test } from '@playwright/test';

/**
 * The Phase 1 critical flow: sign in → select project → submit a task → see it
 * stored with history. Provider execution is NOT exercised here (no live keys
 * in CI); the run path is covered by the engine unit tests with fakes.
 *
 * Requires:
 *  - dev server (playwright starts it via webServer)
 *  - Supabase env configured
 *  - a seeded account: E2E_EMAIL / E2E_PASSWORD (see README "E2E setup")
 */

const email = process.env.E2E_EMAIL;
const password = process.env.E2E_PASSWORD;

test.describe('critical flow', () => {
  test.skip(!email || !password, 'E2E_EMAIL / E2E_PASSWORD not configured');

  test('sign in, pick a workspace, create a task, see it in history', async ({ page }) => {
    // --- Sign in -----------------------------------------------------------
    await page.goto('/login');
    await page.getByLabel('Email').fill(email!);
    await page.getByLabel('Password').fill(password!);
    await page.getByRole('button', { name: 'Sign in' }).click();

    // --- Project selector --------------------------------------------------
    await expect(page).toHaveURL(/\/projects/);
    await expect(page.getByText('Select a workspace')).toBeVisible();
    await page.getByRole('link', { name: /AccurateBids/ }).click();

    // --- Dashboard ---------------------------------------------------------
    await expect(page).toHaveURL(/\/p\/accuratebids/);
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();

    // --- New task ----------------------------------------------------------
    await page.getByRole('link', { name: '+ New task' }).click();
    const title = `E2E task ${Date.now()}`;
    await page.getByLabel('Title').fill(title);
    await page
      .getByLabel('Task brief')
      .fill('E2E smoke: reply with the single word "pong". Do not propose any actions.');
    await page.getByRole('button', { name: 'Create task' }).click();

    // --- Task detail: created, pending, visible ----------------------------
    await expect(page).toHaveURL(/\/tasks\//);
    await expect(page.getByRole('heading', { name: title })).toBeVisible();

    // --- History: shows up on the dashboard --------------------------------
    await page.getByRole('link', { name: 'Dashboard' }).click();
    await expect(page.getByRole('link', { name: new RegExp(title) })).toBeVisible();

    // --- Isolation smoke: another workspace shows no trace of it -----------
    await page.goto('/projects');
    await page.getByRole('link', { name: /KodiScan/ }).click();
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
    await expect(page.getByText(title)).toHaveCount(0);
  });

  test('audit log page renders', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Email').fill(email!);
    await page.getByLabel('Password').fill(password!);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByRole('link', { name: /AccurateBids/ }).click();
    await page.getByRole('link', { name: 'Audit' }).click();
    await expect(page.getByRole('heading', { name: 'Audit log' })).toBeVisible();
    await expect(page.getByText('Append-only and hash-chained')).toBeVisible();
  });
});
