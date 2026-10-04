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

    // The old prompt generator remains removed; starred prompts have their own action.
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

  test('rewrites the current prompt using modification prompts and applies only on acceptance', async ({ page }) => {
    await page.route('**/api/images/rewrite-prompt/capabilities', route => route.fulfill({ json: [{
      base: 'llm.rewriter', raw: 'llm.rewriter[tools]', tags: ['tools'], online: true,
      last_available_at: new Date().toISOString(), usage_count: 0,
    }] }));
    await page.route('**/api/images/rewrite-prompt', async route => {
      expect(route.request().postDataJSON()).toEqual({
        capability: 'llm.rewriter', prompt: 'A {color} bird named {?}',
        system_prompt: 'Return only an improved prompt.', user_prompt: 'Make this cinematic: {}',
      });
      await route.fulfill({ json: { text: 'A cinematic {color} bird named {?}' } });
    });
    await page.goto('/app/images');
    const prompt = page.getByTestId('imggen-prompt');
    await prompt.fill('A {color} bird named {?}');
    await page.getByTestId('imggen-rewrite-open').click();
    await expect(page.getByTestId('imggen-rewrite-input')).toHaveValue('A {color} bird named {?}');
    await page.getByTestId('imggen-rewrite-system').fill('Return only an improved prompt.');
    await page.getByTestId('imggen-rewrite-user').fill('Make this cinematic: {}');
    await page.getByTestId('imggen-rewrite-generate').click();
    await expect(page.getByTestId('imggen-rewrite-result')).toHaveValue('A cinematic {color} bird named {?}');
    await expect(prompt).toHaveValue('A {color} bird named {?}');
    await page.getByTestId('imggen-rewrite-result').fill('An edited cinematic bird');
    await page.getByTestId('imggen-rewrite-apply').click();
    await expect(page.getByTestId('imggen-rewrite-dialog')).not.toBeVisible();
    await expect(prompt).toHaveValue('An edited cinematic bird');
    await page.getByTestId('imggen-rewrite-open').click();
    await expect(page.getByTestId('imggen-rewrite-input')).toHaveValue('An edited cinematic bird');
    await expect(page.getByTestId('imggen-rewrite-system')).toHaveValue('Return only an improved prompt.');
    await expect(page.getByTestId('imggen-rewrite-user')).toHaveValue('Make this cinematic: {}');
    await expect(page.getByTestId('imggen-rewrite-result')).toHaveCount(0);
  });

  test('shows rewrite failures, allows retry, and keeps the original when dismissed', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.route('**/api/images/rewrite-prompt/capabilities', route => route.fulfill({ json: [{
      base: 'llm.rewriter', raw: 'llm.rewriter', tags: [], online: true,
      last_available_at: new Date().toISOString(), usage_count: 0,
    }] }));
    let attempt = 0;
    await page.route('**/api/images/rewrite-prompt', route => route.fulfill(++attempt === 1
      ? { status: 502, json: { error: 'Model returned an empty response' } }
      : { json: { text: 'Rewritten landscape' } }));
    await page.goto('/app/images');
    await page.getByTestId('imggen-prompt').fill('A landscape');
    await page.getByTestId('imggen-rewrite-open').click();
    const dialog = page.getByTestId('imggen-rewrite-dialog');
    await page.getByTestId('imggen-rewrite-generate').click();
    await expect(page.getByTestId('imggen-rewrite-error')).toHaveText('Model returned an empty response');
    await expect(page.getByTestId('imggen-rewrite-apply')).toHaveCount(0);
    await page.getByTestId('imggen-rewrite-generate').click();
    await expect(page.getByTestId('imggen-rewrite-result')).toHaveValue('Rewritten landscape');
    const bounds = await dialog.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
    await dialog.getByRole('button', { name: 'Close', exact: true }).last().click();
    await expect(page.getByTestId('imggen-prompt')).toHaveValue('A landscape');
  });

  test('requires a nonempty current prompt and an online rewrite model', async ({ page }) => {
    await page.route('**/api/images/rewrite-prompt/capabilities', route => route.fulfill({ json: [] }));
    await page.goto('/app/images');
    await page.getByTestId('imggen-prompt').fill('');
    await expect(page.getByTestId('imggen-rewrite-open')).toBeDisabled();
    await page.getByTestId('imggen-prompt').fill('A bird');
    await page.getByTestId('imggen-rewrite-open').click();
    await expect(page.getByText('No LLM models are online. Refresh the model list to try again.')).toBeVisible();
    await expect(page.getByTestId('imggen-rewrite-generate')).toBeDisabled();
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
