import { test, expect } from '@playwright/test';

test.describe('Image Generation Functionality', () => {
  const password = 'password123';

  test.beforeEach(async ({ page }) => {
    // Register and login before tests — a fresh user per test, since one worker
    // may run several tests and a login can only be registered once.
    const username = `imguser_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
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
    await page.goto('/app/images');

    const promptInput = page.locator('data-testid=imggen-prompt');
    await expect(promptInput).toBeVisible();
    await promptInput.fill('My broken starred prompt test');

    // Open the saved-prompts drawer and star the current text.
    await page.locator('data-testid=prompt-list-open').first().click();
    const drawer = page.locator('data-testid=prompt-library-drawer');
    await expect(drawer).toBeVisible();
    await page.locator('data-testid=prompt-add-favorite').click();
    // Starring switches to the Starred tab once saved — wait for it before reloading.
    await expect(
      drawer.locator('[data-testid^="prompt-starred-"]').getByText('My broken starred prompt test'),
    ).toBeVisible();

    // Reload to verify it persisted.
    await page.reload();
    await page.locator('data-testid=prompt-list-open').first().click(); // first() for the main prompt
    await page.locator('data-testid=prompt-tab-starred').click();

    const starredItem = drawer.locator('[data-testid^="prompt-starred-"]').getByText('My broken starred prompt test');
    await expect(starredItem).toBeVisible();

    // Picking it closes the drawer and fills the textarea.
    await starredItem.click();
    await expect(drawer).not.toBeVisible();
    await expect(promptInput).toHaveValue('My broken starred prompt test');
  });

  test('Starred prompts button opens the drawer on the Starred tab', async ({ page }) => {
    await page.goto('/app/images');
    const promptInput = page.locator('data-testid=imggen-prompt');
    const drawer = page.locator('data-testid=prompt-library-drawer');

    // The prompt generator is gone; its slot now holds the Starred prompts button.
    await expect(page.locator('data-testid=imggen-promptgen-open')).toHaveCount(0);

    await promptInput.fill('A lighthouse in a storm');
    await page.locator('data-testid=prompt-list-open').first().click();
    await page.locator('data-testid=prompt-add-favorite').click();
    await expect(drawer.getByText('A lighthouse in a storm')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(drawer).not.toBeVisible();

    // Opens straight on Starred, even though the textarea's own drawer last showed Recent.
    await page.locator('data-testid=imggen-starred-prompts-open').click();
    await expect(drawer).toBeVisible();
    await expect(page.locator('data-testid=prompt-tab-starred')).toHaveAttribute('aria-pressed', 'true');
    const item = drawer.locator('[data-testid^="prompt-starred-"]').getByText('A lighthouse in a storm');
    await expect(item).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(drawer).not.toBeVisible();

    // Picking fills the prompt and closes the drawer.
    await promptInput.fill('');
    await page.locator('data-testid=imggen-starred-prompts-open').click();
    await drawer.locator('[data-testid^="prompt-starred-"]').getByText('A lighthouse in a storm').click();
    await expect(drawer).not.toBeVisible();
    await expect(promptInput).toHaveValue('A lighthouse in a storm');

    // Reopening lands on Starred again after switching tabs.
    await page.locator('data-testid=imggen-starred-prompts-open').click();
    await page.locator('data-testid=prompt-tab-recent').click();
    await page.keyboard.press('Escape');
    await expect(drawer).not.toBeVisible();
    await page.locator('data-testid=imggen-starred-prompts-open').click();
    await expect(page.locator('data-testid=prompt-tab-starred')).toHaveAttribute('aria-pressed', 'true');
  });

  test('saved prompts drawer searches favorites and switches view modes', async ({ page }) => {
    await page.goto('/app/images');
    const promptInput = page.locator('data-testid=imggen-prompt');
    const drawer = page.locator('data-testid=prompt-library-drawer');

    for (const text of ['Crimson fox at dawn', 'Blue whale in the deep sea']) {
      await promptInput.fill(text);
      await page.locator('data-testid=prompt-list-open').first().click();
      await page.locator('data-testid=prompt-add-favorite').click();
      await expect(drawer.getByText(text)).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(drawer).not.toBeVisible();
    }

    await page.locator('data-testid=prompt-list-open').first().click();
    await page.locator('data-testid=prompt-tab-starred').click();
    const items = drawer.locator('[data-testid^="prompt-starred-"]');
    await expect(items).toHaveCount(2);

    // Server-side search, case-insensitive, with the match highlighted.
    await page.locator('data-testid=prompt-search').fill('FOX');
    await expect(items).toHaveCount(1);
    await expect(items.first()).toContainText('Crimson fox at dawn');
    await expect(items.first().locator('mark')).toHaveText('fox');

    await page.locator('data-testid=prompt-search').fill('no such prompt');
    await expect(page.locator('data-testid=prompt-library-empty')).toBeVisible();
    await page.locator('data-testid=prompt-search-clear').click();
    await expect(items).toHaveCount(2);

    // View modes (image prompts only); the choice persists per bucket.
    await page.locator('data-testid=prompt-view-gallery').click();
    await expect(drawer.locator('data-testid=prompt-list-gallery')).toBeVisible();
    await page.locator('data-testid=prompt-view-text').click();
    await expect(drawer.locator('data-testid=prompt-list-text')).toBeVisible();

    await page.reload();
    await page.locator('data-testid=prompt-list-open').first().click();
    await page.locator('data-testid=prompt-tab-starred').click();
    await expect(drawer.locator('data-testid=prompt-list-text')).toBeVisible();
    await expect(page.locator('data-testid=prompt-view-text')).toHaveAttribute('aria-pressed', 'true');
  });

  test('saved prompts drawer loads more favorites on scroll', async ({ page }) => {
    await page.goto('/app/images');
    const token = await page.evaluate(() => localStorage.getItem('oai_token'));
    for (let i = 0; i < 50; i++) {
      const res = await page.request.post('/api/prompts/imggen-prompt/star', {
        headers: { Authorization: `Bearer ${token}` },
        data: { content: `seeded favorite ${String(i).padStart(2, '0')}` },
      });
      expect(res.ok()).toBeTruthy();
    }

    await page.locator('data-testid=prompt-list-open').first().click();
    await page.locator('data-testid=prompt-tab-starred').click();
    const drawer = page.locator('data-testid=prompt-library-drawer');
    const items = drawer.locator('[data-testid^="prompt-starred-"]');
    await expect(items).toHaveCount(40);

    await page.locator('data-testid=prompt-load-more-sentinel').scrollIntoViewIfNeeded();
    await expect(items).toHaveCount(50);
    await expect(drawer.getByText('seeded favorite 00')).toBeVisible();
  });
});
