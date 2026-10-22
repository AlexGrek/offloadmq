import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import builtins from '../../backend/src/default_prompts.json'

const path = '/api/me/prompt-defaults'
const custom = {
  describe_image: 'Describe colors and textures.',
  chat: 'You are my personal writing coach.',
  image_cycles: 'Describe only the composition for the next cycle.',
  generator_improver: 'Assess lighting and preserve the subject.',
}
const empty = Object.fromEntries(Object.keys(custom).map(key => [key, null]))

async function register(request: APIRequestContext) {
  const response = await request.post('/api/auth/register', {
    data: { login: `prompt_${Date.now()}_${Math.random().toString(36).slice(2)}`, password: 'password123' },
  })
  expect(response.ok()).toBeTruthy()
  const account = await response.json()
  return { ...account, headers: { Authorization: `Bearer ${account.token}` } }
}

async function signIn(page: Page, token: string) {
  await page.goto('/login')
  await page.evaluate(value => localStorage.setItem('oai_token', value), token)
}

test('user prompt defaults persist, stay independent, reset, and are isolated from other users', async ({ page, request }) => {
  const a = await register(request)
  const b = await register(request)
  await signIn(page, a.token)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.evaluate(() => localStorage.setItem('oai_theme', 'dark'))
  await page.goto('/app/settings')
  for (const [key, value] of Object.entries(custom)) {
    await page.getByTestId(`default-prompt-${key}`).fill(value)
  }
  await page.getByTestId('prompt-defaults-save').click()
  await expect(page.getByTestId('prompt-defaults-saved')).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy()
  await page.reload()
  for (const [key, value] of Object.entries(custom)) {
    await expect(page.getByTestId(`default-prompt-${key}`)).toHaveValue(value)
  }
  for (const [route, testId, value] of [
    ['/app/describe', 'describe-prompt-input', custom.describe_image],
    ['/app/chat', 'system-prompt-editor', custom.chat],
    ['/app/image-cycles', 'cycles-describe-prompt', custom.image_cycles],
    ['/app/generator-improver', 'cycles-describe-prompt', custom.generator_improver],
  ]) {
    await page.goto(route)
    await expect(page.getByTestId(testId)).toHaveValue(value)
  }
  expect(await (await request.get(path, { headers: b.headers })).json()).toEqual(empty)
  const explicit = await request.post('/api/chats', { headers: a.headers, data: { system_prompt: 'Explicit chat prompt' } })
  const explicitChat = await explicit.json()
  expect(explicitChat.system_prompt).toBe('Explicit chat prompt')
  const chat = await request.post('/api/chats', { headers: a.headers, data: {} })
  expect((await chat.json()).system_prompt).toBe(custom.chat)

  await page.goto('/app/settings')
  await page.getByTestId('default-prompt-reset-chat').click()
  await page.getByTestId('default-prompt-describe_image').fill('  \n ')
  await page.getByTestId('prompt-defaults-save').click()
  await expect(page.getByTestId('prompt-defaults-saved')).toBeVisible()
  const stored = await (await request.get(path, { headers: a.headers })).json()
  expect(stored).toEqual({ ...custom, chat: null, describe_image: null })
  const defaultChat = await request.post('/api/chats', { headers: a.headers, data: { system_prompt: '  ' } })
  expect((await defaultChat.json()).system_prompt).toBe(builtins.chat)
  const chats = await (await request.get('/api/chats', { headers: a.headers })).json()
  // Resetting defaults leaves the explicit prompt stored on existing chats.
  expect(chats.find((item: { id: string }) => item.id === explicitChat.id).system_prompt).toBe('Explicit chat prompt')
  await page.goto('/app/describe')
  await expect(page.getByTestId('describe-prompt-input')).toHaveValue(builtins.describe_image)
})

test('chat carries the previous prompt into new chats and restores it for one day per user', async ({ page, request }) => {
  const account = await register(request)
  await request.put(path, { headers: account.headers, data: custom })
  await signIn(page, account.token)
  await page.goto('/app/chat')
  await expect(page.getByTestId('system-prompt-editor')).toHaveValue(custom.chat)
  const previous = 'Keep this prompt from the previous chat.'
  await page.getByTestId('system-prompt-editor').fill(previous)
  await page.getByTestId('system-prompt-apply').click()
  await expect.poll(async () => (await (await request.get('/api/chats', { headers: account.headers })).json()).length).toBe(1)
  await page.getByTestId('new-chat-btn').click()
  await expect.poll(async () => (await (await request.get('/api/chats', { headers: account.headers })).json()).length).toBe(2)
  const chats = await (await request.get('/api/chats', { headers: account.headers })).json()
  expect(chats.every((chat: { system_prompt: string }) => chat.system_prompt === previous)).toBeTruthy()
  await page.reload()
  await expect(page.getByTestId('system-prompt-editor')).toHaveValue(previous)
  const key = `oai_chat_system_prompt:${account.user_id}`
  await page.evaluate(key => {
    const cached = JSON.parse(localStorage.getItem(key)!)
    cached.savedAt = Date.now() - 24 * 60 * 60 * 1000 - 1
    localStorage.setItem(key, JSON.stringify(cached))
  }, key)
  await page.reload()
  await expect(page.getByTestId('system-prompt-editor')).toHaveValue(custom.chat)
  expect(await page.evaluate(key => localStorage.getItem(key), key)).toBeNull()

  await page.evaluate(key => localStorage.setItem(key, JSON.stringify({ prompt: 'Another user cache', savedAt: Date.now() })), key)
  const other = await register(request)
  await signIn(page, other.token)
  await page.goto('/app/chat')
  await expect(page.getByTestId('system-prompt-editor')).toHaveValue(builtins.chat)
})

test('prompt settings enforce authentication and validate text before saving', async ({ request }) => {
  for (const headers of [{}, { Authorization: 'Bearer invalid' }]) {
    expect((await request.get(path, { headers })).status()).toBe(401)
    expect((await request.put(path, { headers, data: custom })).status()).toBe(401)
  }
  const account = await register(request)
  expect((await request.put(path, { headers: account.headers, data: { ...custom, chat: 'x'.repeat(32001) } })).status()).toBe(400)
  expect(await (await request.get(path, { headers: account.headers })).json()).toEqual(empty)
})
