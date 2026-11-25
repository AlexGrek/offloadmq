import { expect, test, type APIRequestContext, type Page } from '@playwright/test'

async function register(request: APIRequestContext) {
  const response = await request.post('/api/auth/register', {
    data: {
      login: `themes_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      password: 'password123',
    },
  })
  expect(response.ok()).toBeTruthy()
  return (await response.json()) as { token: string }
}

async function signIn(page: Page, token: string) {
  await page.goto('/login')
  await page.evaluate(value => {
    localStorage.setItem('oai_token', value)
    localStorage.setItem('oai_theme', 'light')
  }, token)
}

const html = (page: Page) =>
  page.evaluate(() => ({
    theme: document.documentElement.dataset.theme,
    dark: document.documentElement.classList.contains('dark'),
    // A transparent <body> (glass themes) shows the wallpaper painted on <html>.
    bg: ((body, root) => (body === 'rgba(0, 0, 0, 0)' ? root : body))(
      getComputedStyle(document.body).backgroundColor,
      getComputedStyle(document.documentElement).backgroundColor,
    ),
  }))

test('theme drop-down switches named themes, keeps .dark in sync and persists', async ({ page, request }) => {
  const account = await register(request)
  await signIn(page, account.token)
  await page.goto('/app/dashboard')

  expect(await html(page)).toMatchObject({ theme: 'light', dark: false })

  const seen = new Set<string>()
  for (const [id, dark] of [
    ['graphite', true],
    ['midnight', true],
    ['sepia', false],
    ['tangerine', false],
    ['sky', false],
    ['ukraine', false],
    ['amethyst', true],
    ['ember', true],
    ['win98', false],
    ['liquid-glass', false],
    ['hacker-green', true],
    ['hacker-blue', true],
    ['hacker-white', true],
    ['aurora', true],
    ['synthwave', true],
    ['nebula', true],
    ['sherbet', false],
    ['lagoon', false],
    ['liquid-glass-dark', true],
    ['win8-dark', true],
    ['crimson', true],
    ['parry-hotter', false],
    ['aero', false],
    ['material', false],
    ['love', false],
    ['monokai', true],
    ['oai-hub', true],
    ['cyberpunk', true],
    ['minimal-light', false],
    ['minimal-dark', true],
    ['dark', true],
  ] as const) {
    await page.getByTestId('theme-picker').click()
    await expect(page.getByTestId('theme-picker-menu')).toBeVisible()
    await page.getByTestId(`theme-option-${id}`).click()
    await expect(page.getByTestId('theme-picker-menu')).toBeHidden()
    const state = await html(page)
    expect(state).toMatchObject({ theme: id, dark })
    seen.add(state.bg)
  }
  // Every theme paints a different background.
  expect(seen.size).toBe(31)

  await page.getByTestId('theme-picker').click()
  await page.getByTestId('theme-option-graphite').click()
  await page.reload()
  expect(await html(page)).toMatchObject({ theme: 'graphite', dark: true })
  expect(await page.evaluate(() => localStorage.getItem('oai_theme'))).toBe('graphite')
})

test('styled themes change radius, fonts and element looks', async ({ page, request }) => {
  const account = await register(request)
  await signIn(page, account.token)
  await page.goto('/app/dashboard')
  const look = () =>
    page.evaluate(() => {
      const button = document.querySelector('[data-testid="theme-picker"]')!
      return {
        radius: getComputedStyle(document.documentElement).getPropertyValue('--radius').trim(),
        font: getComputedStyle(document.body).fontFamily,
        buttonRadius: getComputedStyle(button).borderTopLeftRadius,
      }
    })
  await expect(page.getByTestId('theme-picker')).toBeVisible()
  const base = await look()

  for (const [id, expected] of [
    ['win98', { radius: '0rem', font: /Tahoma/, buttonRadius: '0px' }],
    ['liquid-glass', { radius: '1.1rem', font: /apple-system/, buttonRadius: '9999px' }],
    ['hacker-green', { radius: '0rem', font: /monospace/, buttonRadius: '0px' }],
    ['liquid-glass-dark', { radius: '1.1rem', font: /apple-system/, buttonRadius: '9999px' }],
    ['win8-dark', { radius: '0rem', font: /Segoe UI/, buttonRadius: '0px' }],
    ['parry-hotter', { radius: '0.3rem', font: /EB Garamond/, buttonRadius: '3.84px' }],
    ['aero', { radius: '0.4rem', font: /Segoe UI/, buttonRadius: '5.12px' }],
    ['material', { radius: '0.25rem', font: /Roboto/, buttonRadius: '3.2px' }],
    ['love', { radius: '1rem', font: /Geist/, buttonRadius: '9999px' }],
    ['monokai', { radius: '0.25rem', font: /Geist/, buttonRadius: '3.2px' }],
    ['oai-hub', { radius: '0.25rem', font: /Arial/, buttonRadius: '3.2px' }],
    ['cyberpunk', { radius: '0rem', font: /Chakra Petch/, buttonRadius: '0px' }],
    ['minimal-light', { radius: '0.375rem', font: /Inter/, buttonRadius: '4.8px' }],
    ['minimal-dark', { radius: '0.375rem', font: /Inter/, buttonRadius: '4.8px' }],
  ] as const) {
    await page.getByTestId('theme-picker').click()
    await page.getByTestId(`theme-option-${id}`).click()
    await expect(page.getByTestId('theme-picker-menu')).toBeHidden()
    const state = await look()
    expect(state.radius).toBe(expected.radius)
    expect(state.font).toMatch(expected.font)
    expect(state.buttonRadius).toBe(expected.buttonRadius)
  }

  // No theme may lay a full-screen overlay over content: it would tint generated images.
  for (const id of ['hacker-green', 'hacker-blue', 'hacker-white', 'win98', 'liquid-glass', 'aurora', 'synthwave', 'nebula', 'sherbet', 'lagoon', 'liquid-glass-dark', 'win8-dark', 'crimson', 'parry-hotter', 'aero', 'material', 'love', 'monokai', 'oai-hub', 'cyberpunk', 'minimal-light', 'minimal-dark']) {
    await page.getByTestId('theme-picker').click()
    await page.getByTestId(`theme-option-${id}`).click()
    await expect(page.getByTestId('theme-picker-menu')).toBeHidden()
    const overlays = await page.evaluate(() =>
      [document.documentElement, document.body].flatMap(el =>
        (['::before', '::after'] as const).filter(pseudo => {
          const s = getComputedStyle(el, pseudo)
          return s.content !== 'none' && s.content !== 'normal' && s.position === 'fixed'
        }),
      ),
    )
    expect(overlays, `${id} overlays content`).toEqual([])
  }

  // Back to a plain palette theme: the styled overrides are gone.
  await page.getByTestId('theme-picker').click()
  await page.getByTestId('theme-option-light').click()
  await expect(page.getByTestId('theme-picker-menu')).toBeHidden()
  expect(await look()).toEqual(base)
})

test('theme list stays on screen and scrolls on a short viewport', async ({ page, request }) => {
  const account = await register(request)
  await signIn(page, account.token)
  await page.setViewportSize({ width: 390, height: 500 })
  await page.goto('/app/dashboard')

  await page.getByTestId('theme-picker').click()
  const menu = page.getByTestId('theme-picker-menu')
  await expect(menu).toBeVisible()
  const box = await menu.evaluate(el => {
    const r = el.getBoundingClientRect()
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, scrolls: el.scrollHeight > el.clientHeight }
  })
  expect(box.top).toBeGreaterThanOrEqual(0)
  expect(box.left).toBeGreaterThanOrEqual(0)
  expect(box.bottom).toBeLessThanOrEqual(500)
  expect(box.right).toBeLessThanOrEqual(390)
  expect(box.scrolls).toBe(true)

  // The last theme is reachable by scrolling the menu.
  const last = menu.locator('[data-testid^="theme-option-"]').last()
  const lastId = (await last.getAttribute('data-testid'))!.replace('theme-option-', '')
  await last.scrollIntoViewIfNeeded()
  await last.click()
  await expect(menu).toBeHidden()
  expect((await html(page)).theme).toBe(lastId)
})

test('unknown stored theme falls back to a valid one', async ({ page, request }) => {
  const account = await register(request)
  await signIn(page, account.token)
  await page.evaluate(() => localStorage.setItem('oai_theme', 'no-such-theme'))
  await page.goto('/app/dashboard')
  expect(['light', 'dark']).toContain((await html(page)).theme)
})
