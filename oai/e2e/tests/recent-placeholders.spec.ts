import { expect, test, type Page } from '@playwright/test'

const tokens = ['{color}', '{animal}', `{${'long_name_'.repeat(7)}}`, '{.cinematic}', '{country}', '{adjective}', '{?}']

async function openRecentPlaceholders(
  page: Page,
  theme = 'light',
  recentTokens = tokens,
  customDefinitions: { id: string; name: string; variants: string[] }[] = [],
) {
  await page.addInitScript(({ tokens, theme }) => {
    localStorage.setItem('oai_token', 'test-token')
    localStorage.setItem('oai_theme', theme)
    localStorage.setItem('oai_imggen_recent_placeholders', JSON.stringify(tokens))
  }, { tokens: recentTokens, theme })
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname
    if (!path.startsWith('/api/')) return route.continue()
    const json = (body: unknown) => route.fulfill({ json: body })
    if (path === '/api/me') return json({ id: 1, login: 'tester', google_id: null, created_at: '2026-10-06T12:00:00Z', used_storage_bytes: 0 })
    if (path === '/api/images/capabilities' || path === '/api/images/jobs') return json([])
    if (path === '/api/prompt-placeholders') return json(customDefinitions)
    if (path === '/api/images/external-resize') return json({ available: false, threshold_bytes: 0 })
    if (path === '/api/progress/running') return json({ jobs: [] })
    return route.fulfill({ status: 404, json: { error: 'Not mocked' } })
  })
  await page.goto('/app/images')
  await page.getByTestId('imggen-prompt').fill('A bird')
  const promptWidth = (await page.getByTestId('imggen-prompt').boundingBox())!.width
  const definitionsLoaded = page.waitForResponse('**/api/prompt-placeholders')
  await page.getByTestId('imggen-recent-placeholders-toggle').click()
  await (await definitionsLoaded).finished()
  await expect(page.getByTestId('imggen-recent-placeholders-list')).toBeVisible()
  return promptWidth
}

for (const [width, theme] of [[320, 'light'], [390, 'dark'], [1280, 'light']] as const) {
  test(`recent placeholder cloud stays within ${width}px in ${theme} mode`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 })
    const originalWidth = await openRecentPlaceholders(page, theme)
    const list = page.getByTestId('imggen-recent-placeholders-list')
    await expect.poll(() => list.evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1)
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1)
    expect((await page.getByTestId('imggen-prompt').boundingBox())!.width).toBe(originalWidth)
    const bounds = await list.boundingBox()
    for (const token of tokens) {
      const button = page.getByTestId(`imggen-recent-placeholder-${token}`)
      await expect(button).toBeVisible()
      const tag = await button.boundingBox()
      expect(tag!.x).toBeGreaterThanOrEqual(bounds!.x)
      expect(tag!.x + tag!.width).toBeLessThanOrEqual(bounds!.x + bounds!.width + 1)
      await expect(page.getByTestId(`imggen-recent-placeholder-copy-${token}`)).toBeVisible()
    }
    await expect(page.getByTestId('imggen-prompt')).toHaveValue('A bird')
    await expect(page.getByTestId('prompt-placeholders-drawer')).toHaveCount(0)
    await page.getByTestId('imggen-recent-placeholders-toggle').click()
    await expect(list).toHaveCount(0)
  })
}

test('copy leaves the prompt intact and clicking a tag still inserts it', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await openRecentPlaceholders(page)
  const copy = page.getByTestId('imggen-recent-placeholder-copy-{color}')
  await copy.click()
  await expect(copy).toHaveAttribute('aria-label', 'Copied')
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('{color}')
  await expect(page.getByTestId('imggen-prompt')).toHaveValue('A bird')
  await page.getByTestId('imggen-recent-placeholder-{color}').click()
  await expect(page.getByTestId('imggen-prompt')).toHaveValue('A bird {color}')
})

test('dice copies an available custom substitution and announces the exact token', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.addInitScript(() => { Math.random = () => 0.999 })
  await openRecentPlaceholders(page, 'dark', tokens, [
    { id: '1', name: '.cinematic', variants: ['cinematic lighting'] },
    { id: '2', name: 'empty', variants: [] },
  ])
  const dice = page.getByTestId('imggen-random-placeholder-copy')
  await expect(page.getByTestId('imggen-recent-placeholders-list').locator('button').last()).toHaveAttribute('data-testid', 'imggen-random-placeholder-copy')
  await dice.click()
  await expect(page.getByTestId('imggen-random-placeholder-notification')).toHaveText('Copied {.cinematic}')
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('{.cinematic}')
  await expect(page.getByTestId('imggen-prompt')).toHaveValue('A bird')
  await expect(page.getByTestId('imggen-random-placeholder-notification')).toHaveCount(0, { timeout: 5000 })
})

test('dice works without recent substitutions and reports clipboard failure', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.addInitScript(() => { Math.random = () => 0 })
  await openRecentPlaceholders(page, 'light', [])
  const dice = page.getByTestId('imggen-random-placeholder-copy')
  await dice.click()
  await expect(page.getByTestId('imggen-random-placeholder-notification')).toHaveText('Copied {?}')
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('{?}')
  await page.evaluate(() => {
    navigator.clipboard.writeText = async () => { throw new Error('Clipboard denied') }
  })
  await dice.click()
  await expect(page.getByTestId('imggen-random-placeholder-notification')).toHaveRole('alert')
  await expect(page.getByTestId('imggen-random-placeholder-notification')).toHaveText("Couldn't copy. Try again.")
  await expect(page.getByTestId('imggen-prompt')).toHaveValue('A bird')
})
