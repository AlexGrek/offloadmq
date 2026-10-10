import { expect, test } from '@playwright/test'

test('Names drawer copies custom and built-in placeholder tokens', async ({ page, context }) => {
  const now = '2026-10-10T12:00:00Z'
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.addInitScript(() => localStorage.setItem('oai_token', 'test-token'))
  await page.route('**/api/**', async route => {
    const { pathname } = new URL(route.request().url())
    if (!pathname.startsWith('/api/')) return route.continue()
    const json = (body: unknown) => route.fulfill({ json: body })

    if (pathname === '/api/me') {
      return json({ id: 1, login: 'tester', google_id: null, created_at: now, used_storage_bytes: 0 })
    }
    if (pathname === '/api/prompt-placeholders') {
      return json([
        { id: 'p1', name: '.cinematic', variants: ['Cinematic lighting'], created_at: now, updated_at: now },
      ])
    }
    if (pathname === '/api/progress/running') return json({ jobs: [] })
    return json({})
  })

  await page.goto('/app/dashboard')
  await page.getByTestId('random-names-toggle').click()
  const drawer = page.getByTestId('prompt-placeholders-drawer')
  await expect(drawer).toBeVisible()

  await drawer.getByTestId('prompt-placeholders-copy-p1').click()
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('{.cinematic}')

  await drawer.getByTestId('prompt-placeholders-copy-builtin-color').click()
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('{color}')

  await drawer.getByTestId('prompt-placeholders-copy-builtin-?').click()
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('{?}')
})
