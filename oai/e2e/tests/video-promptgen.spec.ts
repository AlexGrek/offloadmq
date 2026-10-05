import { expect, test, type Page, type WebSocketRoute } from '@playwright/test'

const now = '2026-10-05T12:00:00Z'
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
type Command = { type: string; req_id: string; capability: string; image_id: string }

async function openGenerator(page: Page, online = true) {
  const commands: Command[] = []
  let socket: WebSocketRoute | undefined
  await page.addInitScript(() => localStorage.setItem('oai_token', 'test-token'))
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname
    if (!path.startsWith('/api/')) return route.continue()
    const json = (body: unknown) => route.fulfill({ json: body })
    if (path === '/api/me') return json({ id: 1, login: 'tester', google_id: null, created_at: now, used_storage_bytes: 0 })
    if (path === '/api/images/capabilities') return json([{
      base: 'imggen.video', raw: 'imggen.video[img2video]', tags: ['img2video'], online: true,
      last_available_at: now, usage_count: 0,
    }])
    if (path === '/api/images/jobs') return json([])
    if (path === '/api/images/upload') return json({
      image_id: '123', filename: 'frame.png', content_type: 'image/png', width: 1024, height: 768,
      size_bytes: 68, rescaled: false, reencoded: false,
    })
    if (path === '/api/images/external-resize') return json({ available: false, threshold_bytes: 0 })
    if (path === '/api/progress/running') return json({ jobs: [] })
    if (path === '/api/prompt-placeholders') return json([])
    return route.fulfill({ status: 404, json: { error: 'Not mocked' } })
  })
  await page.routeWebSocket('**/api/ws/promptgen*', ws => {
    socket = ws
    ws.onMessage(message => {
      const command = JSON.parse(message.toString()) as Command
      if (command.type === 'list_capabilities') {
        ws.send(JSON.stringify({ type: 'capabilities', req_id: command.req_id, capabilities: [{
          base: 'llm.vision', raw: 'llm.vision[vision]', tags: ['vision'], online,
          last_available_at: now, usage_count: 0,
        }] }))
      } else if (command.type === 'generate_video_prompt') {
        commands.push(command)
      } else if (command.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }))
      }
    })
  })
  await page.goto('/app/images')
  await page.getByTestId('imggen-mode-img2video').click()
  await page.getByTestId('imggen-upload-input').setInputFiles({ name: 'frame.png', mimeType: 'image/png', buffer: png })
  await expect(page.getByTestId('imggen-video-promptgen')).toBeVisible()
  await page.getByTestId('imggen-prompt').fill('Original video prompt')
  return {
    commands,
    respond: (event: object) => {
      expect(socket).toBeDefined()
      socket!.send(JSON.stringify(event))
    },
  }
}

test('video prompt generator accepts the blocking result without a queued event', async ({ page }) => {
  const { commands, respond } = await openGenerator(page)
  await page.getByTestId('video-promptgen-generate').click()
  await expect.poll(() => commands.length).toBe(1)
  expect(commands[0]).toMatchObject({ capability: 'llm.vision', image_id: '123' })
  await expect(page.getByTestId('imggen-prompt')).toHaveValue('Original video prompt')
  await expect(page.getByTestId('video-promptgen-stop')).toContainText('Stop waiting')
  respond({ type: 'task:result', req_id: commands[0].req_id, cap: 'llm.vision', id: 'task-1', text: 'The bird takes flight.' })
  await expect(page.getByTestId('imggen-prompt')).toHaveValue('The bird takes flight.')
  await expect(page.getByTestId('video-promptgen-generate')).toBeEnabled()
})

test('stopping the wait ignores a late result and errors allow retry', async ({ page }) => {
  const { commands, respond } = await openGenerator(page)
  await page.getByTestId('video-promptgen-generate').click()
  await expect.poll(() => commands.length).toBe(1)
  await page.getByTestId('video-promptgen-stop').click()
  await page.getByTestId('video-promptgen-generate').click()
  await expect.poll(() => commands.length).toBe(2)
  respond({ type: 'task:result', req_id: commands[0].req_id, cap: 'llm.vision', id: 'task-1', text: 'Stale result' })
  respond({ type: 'error', req_id: commands[1].req_id, message: 'Model returned an empty response' })
  await expect(page.getByTestId('video-promptgen-error')).toHaveText('Model returned an empty response')
  await expect(page.getByTestId('imggen-prompt')).toHaveValue('Original video prompt')
  await page.getByTestId('video-promptgen-generate').click()
  await expect.poll(() => commands.length).toBe(3)
  respond({ type: 'task:result', req_id: commands[2].req_id, cap: 'llm.vision', id: 'task-3', text: 'Fresh result' })
  await expect(page.getByTestId('imggen-prompt')).toHaveValue('Fresh result')
  await expect(page.getByTestId('video-promptgen-error')).toHaveCount(0)
})

test('video prompt generator requires an online vision model for urgent inference', async ({ page }) => {
  const { commands } = await openGenerator(page, false)
  await expect(page.getByTestId('video-promptgen-generate')).toBeDisabled()
  expect(commands).toHaveLength(0)
})
