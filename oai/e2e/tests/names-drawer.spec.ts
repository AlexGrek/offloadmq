import { test, expect, type Page } from '@playwright/test'

const longName = 'a'.repeat(64)
const longVariant = 'long_variant_without_spaces_'.repeat(30)

async function openDrawer(page: Page, theme = 'light') {
  await page.addInitScript(theme => {
    localStorage.setItem('oai_token', 'test-token')
    localStorage.setItem('oai_theme', theme)
  }, theme)
  let items = [
    { id: '1', name: '.cinematic', variants: ['Cinematic lighting', 'Cinematic colors'] },
    { id: '2', name: 'landscape', variants: ['Mountains'] },
    { id: '3', name: longName, variants: [longVariant] },
  ]
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname
    if (!path.startsWith('/api/')) return route.continue()
    const json = (body: unknown) => route.fulfill({ json: body })
    if (path === '/api/me') return json({ id: 1, login: 'tester', google_id: null, created_at: '2026-10-06T12:00:00Z', used_storage_bytes: 0 })
    if (path === '/api/images/capabilities' || path === '/api/images/jobs') return json([])
    if (path === '/api/images/external-resize') return json({ available: false, threshold_bytes: 0 })
    if (path === '/api/progress/running') return json({ jobs: [] })
    if (path === '/api/names/random') return json({ names: [{ slug: 'calm-fox', phrase: 'calm fox' }] })
    if (path === '/api/prompt-placeholders') {
      if (route.request().method() === 'POST') {
        const body = route.request().postDataJSON()
        const item = { id: '4', ...body }
        items.push(item)
        return json(item)
      }
      return json(items)
    }
    if (path === '/api/prompt-placeholders/1') {
      if (route.request().method() === 'DELETE') {
        items = items.filter(item => item.id !== '1')
        return route.fulfill({ status: 204 })
      }
      const body = route.request().postDataJSON()
      items = items.map(item => item.id === '1' ? { ...item, ...body } : item)
      return json(items.find(item => item.id === '1'))
    }
    return route.fulfill({ status: 404, json: { error: 'Not mocked' } })
  })
  await page.goto('/app/images')
  await page.getByTestId('random-names-toggle').click()
  await expect(page.getByTestId('prompt-placeholders-item-1')).toBeVisible()
}

async function expectNoOverflow(page: Page) {
  for (const id of ['prompt-placeholders-drawer', 'prompt-placeholders-panel']) {
    await expect.poll(() => page.getByTestId(id).evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1)
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1)
}

for (const width of [320, 390, 1280]) {
  for (const theme of ['light', 'dark']) {
    test(`placeholder tags fit ${width}px in ${theme} mode, including long previews`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 })
      await openDrawer(page, theme)
      await expectNoOverflow(page)
      const first = await page.getByTestId('prompt-placeholders-item-1').boundingBox()
      const second = await page.getByTestId('prompt-placeholders-item-2').boundingBox()
      expect(first!.y).toBe(second!.y)
      await page.getByTestId('prompt-placeholders-preview-3').click()
      await expect(page.getByTestId('prompt-placeholders-preview-result-3')).toHaveText(longVariant)
      await expectNoOverflow(page)
      await page.getByTestId('prompt-placeholders-open-page').click()
      await expect(page).toHaveURL(/\/app\/prompt-placeholders/)
      await page.getByTestId('prompt-placeholders-preview-3').click()
      await expectNoOverflowOnPage(page)
    })
  }
}

async function expectNoOverflowOnPage(page: Page) {
  expect(await page.getByTestId('prompt-placeholders-panel').evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1)
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1)
}

test('copies custom tags, built-in tags, and quick names without changing the prompt', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await openDrawer(page)
  const originalPrompt = await page.getByTestId('imggen-prompt').inputValue()
  for (const [id, value] of [
    ['prompt-placeholders-copy-1', '{.cinematic}'],
    ['prompt-placeholders-copy-reserved-color', '{color}'],
    ['prompt-placeholders-copy-reserved-?', '{?}'],
  ]) {
    await page.getByTestId(id).click()
    await expect(page.getByTestId(id)).toHaveAttribute('aria-label', 'Copied')
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(value)
  }
  await expect(page.getByTestId('prompt-placeholders-preview-result-1')).toHaveCount(0)
  await page.getByTestId('random-names-section-toggle').click()
  await page.getByTestId('random-names-copy-calm-fox').click()
  await expect(page.getByTestId('random-names-copy-calm-fox')).toHaveAttribute('aria-label', 'Copied')
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('calm fox')
  await expect(page.getByTestId('imggen-prompt')).toHaveValue(originalPrompt)
  await expectNoOverflow(page)
})

test('custom tags keep create, preview, edit, and delete available', async ({ page }) => {
  await openDrawer(page)
  await page.getByTestId('prompt-placeholders-add-open').click()
  await page.getByTestId('prompt-placeholders-add-name').fill('new_tag')
  await page.getByTestId('prompt-placeholders-add-variants').fill('New variant')
  await page.getByTestId('prompt-placeholders-add-submit').click()
  await expect(page.getByTestId('prompt-placeholders-item-4')).toContainText('{new_tag}')
  await page.getByTestId('prompt-placeholders-preview-1').click()
  await page.getByTestId('prompt-placeholders-edit-1').click()
  await page.getByTestId('prompt-placeholders-add-variants').fill('Updated preview')
  await page.getByTestId('prompt-placeholders-add-submit').click()
  await page.getByRole('button', { name: 'Another preview', exact: true }).click()
  await expect(page.getByTestId('prompt-placeholders-preview-result-1')).toHaveText('Updated preview')
  page.once('dialog', dialog => dialog.accept())
  await page.getByTestId('prompt-placeholders-delete-1').click()
  await expect(page.getByTestId('prompt-placeholders-item-1')).toHaveCount(0)
})
