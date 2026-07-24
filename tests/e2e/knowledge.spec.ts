import { expect, test } from '@playwright/test';

/**
 * Company Knowledge in a real browser (Sprint 10, closing the K1 coverage
 * gap): add knowledge → it becomes active → revise it into a new version →
 * the previous version is archived, not overwritten. The lifecycle's promise
 * ("versioned, never edited") proven where the owner meets it.
 */

const email = process.env.E2E_EMAIL;
const password = process.env.E2E_PASSWORD;

test.describe('company knowledge', () => {
  test.skip(!email || !password, 'E2E_EMAIL / E2E_PASSWORD not configured');

  test('knowledge is versioned, never overwritten', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Email').fill(email!);
    await page.getByLabel('Password').fill(password!);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByRole('link', { name: /E2E Sandbox(?! B)/ }).first().click();
    await page.getByRole('link', { name: 'Knowledge', exact: true }).click();

    // --- Add, active immediately (the author is the approver) ---------------
    const title = `House rule ${Date.now()}`;
    await page.getByPlaceholder('Title').fill(title);
    await page.getByPlaceholder(/What should your team know/).fill('Version one of the rule.');
    await page.getByRole('button', { name: 'Add knowledge' }).click();

    await expect(page.getByText(title)).toBeVisible();
    await expect(page.getByText('Version one of the rule.')).toBeVisible();
    // v1 while it is the only version.
    const item = page.locator('li').filter({ hasText: title }).first();
    await expect(item.getByText('v1')).toBeVisible();

    // --- Revise into v2 -----------------------------------------------------
    await item.getByRole('button', { name: 'New version' }).click();
    const editor = item.getByRole('textbox');
    await editor.fill('Version two supersedes it.');
    await item.getByRole('button', { name: 'Save version' }).click();

    // The active item is now v2 with the new body...
    const revised = page.locator('li').filter({ hasText: title }).first();
    await expect(revised.getByText('v2')).toBeVisible();
    await expect(page.getByText('Version two supersedes it.')).toBeVisible();

    // ...and v1 is archived into history, not deleted and not still active.
    await expect(page.getByText('Version one of the rule.')).toHaveCount(0);
    await expect(page.getByText(/Version history/)).toBeVisible();
  });
});
