import { expect, test } from '@playwright/test';

/**
 * The objectives flow in a real browser (Sprint 5): create with a success
 * criterion → activate → completion REFUSED while the criterion is unmet →
 * mark met → complete. Pins the gate where the user meets it, not just in the
 * domain layer.
 */

const email = process.env.E2E_EMAIL;
const password = process.env.E2E_PASSWORD;

test.describe('objectives', () => {
  test.skip(!email || !password, 'E2E_EMAIL / E2E_PASSWORD not configured');

  test('the completion gate holds in the UI', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Email').fill(email!);
    await page.getByLabel('Password').fill(password!);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByRole('link', { name: /E2E Sandbox(?! B)/ }).click();

    // --- Create ------------------------------------------------------------
    await page.getByRole('link', { name: 'Objectives', exact: true }).click();
    await page.getByRole('link', { name: '+ New objective' }).click();
    const title = `E2E objective ${Date.now()}`;
    await page.getByLabel('What are you trying to achieve?').fill(title);
    await page.getByPlaceholder(/100 beta users/).fill('One criterion to rule it');
    await page.getByPlaceholder('Target').fill('1');
    await page.getByRole('button', { name: 'Create objective' }).click();

    await expect(page.getByRole('heading', { name: title })).toBeVisible();
    await expect(page.getByText('One criterion to rule it')).toBeVisible();

    // --- Activate ----------------------------------------------------------
    await page.getByRole('button', { name: 'Activate' }).click();
    await expect(page.getByRole('button', { name: 'Mark completed' })).toBeVisible();

    // --- The gate: completion refused while the criterion is unmet ----------
    await page.getByRole('button', { name: 'Mark completed' }).click();
    await expect(page.getByText(/Cannot complete/)).toBeVisible();

    // --- Satisfy the criterion, then complete -------------------------------
    await page.getByRole('button', { name: 'Mark met' }).click();
    await expect(page.getByText('met', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Mark completed' }).click();

    // Closed: status shows completed and mutation controls are gone.
    await expect(page.getByRole('button', { name: 'Mark completed' })).toHaveCount(0);
    await expect(page.getByText('completed', { exact: true }).first()).toBeVisible();
  });
});
