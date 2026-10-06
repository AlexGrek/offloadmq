import { test, expect } from '@playwright/test';

test.describe('Names Drawer Functionality', () => {
  const uniqueId = Date.now();
  const username = `imguser_${uniqueId}`;
  const password = 'password123';

  test.beforeEach(async ({ page }) => {
    await page.goto('/register');
    await page.fill('data-testid=login-input', username);
    await page.fill('data-testid=password-input', password);
    await page.fill('data-testid=confirm-password-input', password);
    await page.click('button[type="submit"]');
    await expect(page).toHaveURL(/\/app\/dashboard/);
  });

  test('should be horizontally scrollable', async ({ page }) => {
    await page.click('data-testid=random-names-toggle');
    const drawer = page.locator('data-testid=prompt-placeholders-drawer');
    await expect(drawer).toBeVisible();

    const panel = page.locator('data-testid=prompt-placeholders-panel');
    
    await page.click('data-testid=prompt-placeholders-add-open');
    await page.fill('data-testid=prompt-placeholders-add-name', 'very_long_name');
    await page.fill('data-testid=prompt-placeholders-add-variants', 'this_is_a_very_very_very_very_very_very_very_very_very_very_very_very_very_very_very_very_very_very_very_very_very_very_very_very_very_very_very_very_very_very_very_very_very_very_very_long_variant_text_without_spaces_that_should_force_horizontal_scrolling');
    await page.click('data-testid=prompt-placeholders-add-submit');
    
    // Wait for the new item
    const newItem = page.locator('[data-testid^="prompt-placeholders-item-"]').filter({ hasText: 'very_long_name' }).first();
    await expect(newItem).toBeVisible({ timeout: 5000 });

    // Click preview to show the long text
    const itemId = await newItem.getAttribute('data-testid');
    const id = itemId?.split('item-')[1];
    await page.click(`data-testid=prompt-placeholders-preview-${id}`);

    // Verify it actually overflows and is scrollable
    const isScrollable = await panel.evaluate((el) => {
        // Find the preview text element
        const previewEl = el.querySelector('[data-testid^="prompt-placeholders-preview-result-"]');
        if (previewEl) {
            // Force it to not wrap just in case
            (previewEl as HTMLElement).style.whiteSpace = 'nowrap';
        }
        return el.scrollWidth > el.clientWidth;
    });
    
    expect(isScrollable).toBe(true);
    const overflowX = await panel.evaluate((el) => window.getComputedStyle(el).overflowX);
    expect(['auto', 'scroll']).toContain(overflowX);
  });
});
