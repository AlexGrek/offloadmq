import { test, expect } from '@playwright/test';

test.describe('Management Frontend Smoke Test', () => {
  test('should load the dashboard and display the main header', async ({ page }) => {
    // Navigate to the app under the correct basename
    await page.goto('/ui');

    // Wait for the app layout to load
    const brandElement = page.locator('.brand');
    await expect(brandElement).toHaveText('Offload MQ Management Console');
    
    // Check if the navigation menu button is visible
    const navButton = page.locator('button[aria-label="Toggle menu"]');
    await expect(navButton).toBeVisible();
  });
});
