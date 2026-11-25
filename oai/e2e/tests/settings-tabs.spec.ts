import { expect, test, type APIRequestContext, type Page } from '@playwright/test'

async function register(request: APIRequestContext) {
  const response = await request.post('/api/auth/register', {
    data: {
      login: `settings_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      password: 'password123',
    },
  })
  expect(response.ok()).toBeTruthy()
  return (await response.json()) as { token: string; user_id: string }
}

async function signIn(page: Page, token: string) {
  await page.goto('/login')
  await page.evaluate(value => localStorage.setItem('oai_token', value), token)
}

test('user settings are tabbed, persist active tab in URL, support keyboard nav, and fit mobile viewports', async ({
  page,
  request,
}) => {
  const account = await register(request)
  await signIn(page, account.token)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/app/settings')

  await expect(page.getByTestId('settings-tabs')).toBeVisible()
  await expect(page.getByTestId('settings-tab-account')).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByTestId('settings-profile-section')).toBeVisible()
  await expect(page.getByTestId('settings-preferences-section')).toBeVisible()
  await expect(page.getByTestId('change-password-form')).toBeHidden()
  await expect(page.getByTestId('prompt-defaults-settings')).toBeHidden()
  await expect(page.getByTestId('reverse-substitution-settings')).toBeHidden()
  await expect(page.getByTestId('settings-tab-admin')).toBeHidden()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy()

  // Switch to Security tab
  await page.getByTestId('settings-tab-security').click()
  await expect(page).toHaveURL(/\/app\/settings\?tab=security$/)
  await expect(page.getByTestId('settings-tab-security')).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByTestId('change-password-form')).toBeVisible()
  await expect(page.getByTestId('settings-profile-section')).toBeHidden()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy()

  // Reload preserves selected tab
  await page.reload()
  await expect(page.getByTestId('settings-tab-security')).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByTestId('change-password-form')).toBeVisible()

  // Keyboard navigation moves to Prompts, then Substitutions
  await page.getByTestId('settings-tab-security').focus()
  await page.keyboard.press('ArrowRight')
  await expect(page).toHaveURL(/\/app\/settings\?tab=prompts$/)
  await expect(page.getByTestId('prompt-defaults-settings')).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy()

  await page.keyboard.press('ArrowRight')
  await expect(page).toHaveURL(/\/app\/settings\?tab=substitutions$/)
  await expect(page.getByTestId('reverse-substitution-settings')).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy()

  // Returning to Account cleans up the query string
  await page.getByTestId('settings-tab-account').click()
  await expect(page).toHaveURL(/\/app\/settings$/)
  await expect(page.getByTestId('settings-profile-section')).toBeVisible()

  // Invalid tab or unauthorized admin tab falls back to Account
  await page.goto('/app/settings?tab=does-not-exist')
  await expect(page.getByTestId('settings-tab-account')).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByTestId('settings-profile-section')).toBeVisible()

  await page.goto('/app/settings?tab=admin')
  await expect(page.getByTestId('settings-tab-admin')).toBeHidden()
  await expect(page.getByTestId('settings-admin-section')).toBeHidden()
  await expect(page.getByTestId('settings-tab-account')).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByTestId('settings-profile-section')).toBeVisible()
})

test('admin users see the Admin settings tab and keep it active on direct load/reload', async ({
  page,
  request,
}) => {
  const account = await register(request)
  await signIn(page, account.token)
  await page.route('**/api/admin/am_i_admin', route =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ is_admin: true }) }),
  )

  await page.goto('/app/settings?tab=admin')
  await expect(page.getByTestId('settings-tab-admin')).toBeVisible()
  await expect(page.getByTestId('settings-tab-admin')).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByTestId('settings-admin-section')).toBeVisible()
  await expect(page.getByTestId('settings-diagnostics-link')).toBeVisible()
  await expect(page.getByTestId('settings-worker-logs-link')).toBeVisible()
})
