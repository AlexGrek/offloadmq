import { test, expect } from '@playwright/test';

test.describe('Image Generation Functionality', () => {
  const uniqueId = Date.now();
  const username = `imguser_${uniqueId}`;
  const password = 'password123';

  test.beforeEach(async ({ page }) => {
    // Register and login before tests
    await page.goto('/register');
    await page.fill('data-testid=login-input', username);
    await page.fill('data-testid=password-input', password);
    await page.fill('data-testid=confirm-password-input', password);
    await page.click('button[type="submit"]');
    await expect(page).toHaveURL(/\/app\/dashboard/);
  });

  test('should be able to navigate to images and interact with generation form', async ({ page }) => {
    // Go to image generation page
    await page.goto('/app/images');

    // Make sure we are on the images page
    await expect(page.locator('data-testid=image-generation-page')).toBeVisible();

    // New generation panel should be visible
    const newPanel = page.locator('data-testid=imggen-new-panel');
    await expect(newPanel).toBeVisible();

    // Fill prompt
    const promptInput = page.locator('data-testid=imggen-prompt');
    await expect(promptInput).toBeVisible();
    await promptInput.fill('A beautiful landscape');

    // Ensure submit button exists
    const submitBtn = page.locator('data-testid=imggen-submit-job');
    await expect(submitBtn).toBeVisible();
    
    // Note: without a real agent, clicking submit might fail validation (e.g. no capability selected).
    // So we just verify the form is present and interactable.
  });

  test('should allow saving and using a starred prompt in txt2img', async ({ page }) => {
    // Go to image generation page
    await page.goto('/app/images');

    // Type a prompt
    const promptInput = page.locator('data-testid=imggen-prompt');
    await expect(promptInput).toBeVisible();
    await promptInput.fill('My broken starred prompt test');

    // Open the prompt library modal
    await page.locator('data-testid=prompt-list-open').click();
    const modal = page.locator('data-testid=prompt-library-modal');
    await expect(modal).toBeVisible();

    // Click Add to favorites
    await page.locator('data-testid=prompt-add-favorite').click();

    // Reload to verify it persisted
    await page.reload();

    // Open the prompt library modal again
    await page.locator('data-testid=prompt-list-open').first().click(); // first() for the main prompt

    // Switch to starred tab
    await page.locator('data-testid=prompt-tab-starred').click();

    // Verify the newly starred prompt is visible in the list
    const starredItem = modal.locator('[data-testid^="prompt-starred-"]').getByText('My broken starred prompt test');
    await expect(starredItem).toBeVisible();

    // Click it to use it
    await starredItem.click();

    // The modal should close and the textarea should contain the text
    // This might fail if the feature is broken!
    await expect(modal).not.toBeVisible();
    await expect(promptInput).toHaveValue('My broken starred prompt test');
  });
});
