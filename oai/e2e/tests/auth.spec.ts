import { test, expect } from '@playwright/test';

test.describe('Authentication', () => {
  const uniqueId = Date.now();
  const username = `testuser_${uniqueId}`;
  const password = 'password123';

  test('should allow a user to register and login', async ({ page }) => {
    // Navigate to the app (should redirect to landing or login)
    await page.goto('/');

    // Go to register page
    await page.goto('/register');
    
    // Fill in registration form
    await page.fill('data-testid=login-input', username);
    await page.fill('data-testid=password-input', password);
    await page.fill('data-testid=confirm-password-input', password);
    await page.click('button[type="submit"]');

    // Should redirect to dashboard on successful registration
    await expect(page).toHaveURL(/\/app\/dashboard/);

    // Logout
    await page.getByRole('button', { name: /sign out/i }).click();

    // Should redirect to login or landing page
    await expect(page).toHaveURL(/login|\//);

    // Login
    await page.goto('/login');
    await page.fill('data-testid=login-input', username);
    await page.fill('data-testid=password-input', password);
    await page.click('button[type="submit"]');

    // Should be back at dashboard
    await expect(page).toHaveURL(/\/app\/dashboard/);
  });
});
