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
    bg: getComputedStyle(document.body).backgroundColor,
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
  expect(seen.size).toBe(14)

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
  ] as const) {
    await page.getByTestId('theme-picker').click()
    await page.getByTestId(`theme-option-${id}`).click()
    await expect(page.getByTestId('theme-picker-menu')).toBeHidden()
    const state = await look()
    expect(state.radius).toBe(expected.radius)
    expect(state.font).toMatch(expected.font)
    expect(state.buttonRadius).toBe(expected.buttonRadius)
  }

  // Back to a plain palette theme: the styled overrides are gone.
  await page.getByTestId('theme-picker').click()
  await page.getByTestId('theme-option-light').click()
  await expect(page.getByTestId('theme-picker-menu')).toBeHidden()
  expect(await look()).toEqual(base)
})

test('unknown stored theme falls back to a valid one', async ({ page, request }) => {
  const account = await register(request)
  await signIn(page, account.token)
  await page.evaluate(() => localStorage.setItem('oai_theme', 'no-such-theme'))
  await page.goto('/app/dashboard')
  expect(['light', 'dark']).toContain((await html(page)).theme)
})
