import { expect, test, type Page } from '@playwright/test'

async function mock(page: Page) {
  await page.addInitScript(() => localStorage.setItem('oai_token', 'test-token'))
  await page.routeWebSocket(/\/api\/ws\//, ws => ws.onMessage(raw => {
    const m = JSON.parse(String(raw))
    if (m.type === 'list_capabilities') ws.send(JSON.stringify({ type: 'capabilities', req_id: m.req_id, capabilities: [] }))
  }))
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname
    if (!path.startsWith('/api/')) return route.continue()
    let json: unknown = []
    if (path === '/api/me') json = { id: 1, login: 'tester', used_storage_bytes: 0 }
    else if (path === '/api/admin/am_i_admin') json = { is_admin: false }
    else if (path === '/api/progress/running') json = { jobs: [] }
    else if (path === '/api/img-utils/capabilities') json = { capabilities: [{ base: 'image_resize', utility: 'resize', workflows: ['basic_resize'], kind: 'resize', methods: ['lanczos'] }] }
    else if (path === '/api/describe/capabilities') json = { capabilities: [] }
    else if (path === '/api/images/external-resize') json = { available: false, threshold_bytes: 0 }
    else if (path.startsWith('/api/prompts/')) json = { items: [], next_cursor: null }
    return route.fulfill({ json })
  })
}

const APPS = [['images', 'imggen'], ['hallucinate', 'hallucinate'], ['image-cycles', 'cycles'], ['generator-improver', 'cycles'], ['img-model-wars', 'wars'], ['movie', 'movie'], ['img-utils', 'imgutils-resize']] as const

test('apps share tinted presets and remember custom dimensions across navigation and reload', async ({ page }) => {
  await mock(page)
  let presets: string[] | undefined
  for (const [route, prefix] of APPS) {
    await page.goto(`/app/${route}`)
    const picker = page.getByTestId(`${prefix}-sizes`)
    await expect(picker).toBeVisible()
    const labels = await picker.locator('button[aria-pressed]').allTextContents()
    if (presets) expect(labels).toEqual(presets)
    else presets = labels
    for (const [orientation, tint] of [['square', 'emerald'], ['portrait', 'sky'], ['landscape', 'orange']]) {
      await expect(picker.locator(`button[data-orientation="${orientation}"]`).first()).toHaveClass(new RegExp(`bg-${tint}-500/10`))
    }
    if (route !== 'images') {
      await expect(page.getByTestId(`${prefix}-width`)).toHaveValue('1112')
      await expect(page.getByTestId(`${prefix}-height`)).toHaveValue('832')
    }
    await page.getByTestId(`${prefix}-width`).fill('1112')
    await page.getByTestId(`${prefix}-height`).fill('832')
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('oai_image_size')!))).toEqual([1112, 832])
  }
  await page.reload()
  await expect(page.getByTestId('imgutils-resize-width')).toHaveValue('1112')
})

for (const theme of ['light', 'dark']) {
  test(`preset selection, swap and manual override fit a phone in ${theme} mode`, async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 844 })
    await mock(page)
    await page.addInitScript(theme => localStorage.setItem('oai_theme', theme), theme)
    await page.goto('/app/hallucinate')
    const preset = page.getByTestId('hallucinate-sizes').getByRole('button', { name: '1080×1920', exact: true })
    await preset.click()
    await expect(preset).toHaveAttribute('aria-pressed', 'true')
    await page.getByTestId('hallucinate-swap-dims').click()
    await expect(page.getByTestId('hallucinate-width')).toHaveValue('1920')
    await expect(page.getByTestId('hallucinate-height')).toHaveValue('1080')
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1)
    await page.getByTestId('hallucinate-width').fill('0')
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('oai_image_size')!))).toEqual([1920, 1080])
  })
}

test('malformed storage uses the app default', async ({ page }) => {
  await mock(page)
  await page.addInitScript(() => localStorage.setItem('oai_image_size', '{broken'))
  await page.goto('/app/hallucinate')
  await expect(page.getByTestId('hallucinate-width')).toHaveValue('1280')
  await expect(page.getByTestId('hallucinate-height')).toHaveValue('720')
})
