import { expect, test, type Page } from '@playwright/test'

const now = '2026-09-30T12:00:00Z'

async function mockChatApi(page: Page, uploads: string[]) {
  await page.addInitScript(() => localStorage.setItem('oai_token', 'test-token'))
  await page.routeWebSocket(/\/api\/ws\/chat/, ws => {
    ws.send(JSON.stringify({ type: 'hello', user_id: '1' }))
    ws.onMessage(raw => {
      const msg = JSON.parse(String(raw))
      if (msg.type === 'list_capabilities') {
        ws.send(JSON.stringify({ type: 'capabilities', req_id: msg.req_id, capabilities: [] }))
      }
    })
  })
  await page.route('**/api/**', async route => {
    const { pathname } = new URL(route.request().url())
    if (!pathname.startsWith('/api/')) return route.continue()
    const method = route.request().method()
    const json = (body: unknown) => route.fulfill({ json: body })

    if (pathname === '/api/me') {
      return json({ id: 1, login: 'tester', google_id: null, created_at: now, used_storage_bytes: 0 })
    }
    if (pathname === '/api/chats' && method === 'GET') {
      return json([
        { id: 'c1', title: 'Paste chat', system_prompt: 'Be helpful.', last_model: null, created_at: now, updated_at: now },
      ])
    }
    if (pathname === '/api/chats/c1/messages') return json([])
    if (pathname === '/api/images/upload' && method === 'POST') {
      const body = route.request().postDataBuffer()?.toString('latin1') ?? ''
      const filename = /filename="([^"]+)"/.exec(body)?.[1] ?? ''
      uploads.push(filename)
      return json({
        image_id: `img-${uploads.length}`,
        filename,
        content_type: 'image/png',
        width: 1,
        height: 1,
        size_bytes: 68,
        rescaled: false,
        reencoded: false,
      })
    }
    if (pathname === '/api/chat/attachments/image' && method === 'POST') {
      const n = uploads.length
      return json({
        attachment: {
          id: `att-${n}`,
          kind: 'image',
          filename: uploads[n - 1],
          content_type: 'image/png',
          size_bytes: 68,
          image_id: `img-${n}`,
          created_at: now,
        },
      })
    }
    if (pathname === '/api/progress/running') return json({ jobs: [] })
    return route.fulfill({ status: 200, json: {} })
  })
}

/** Dispatches a paste carrying a 1×1 PNG (and optional plain text) at the focused element. */
async function pasteImage(page: Page, text = '') {
  await page.evaluate(t => {
    const png = Uint8Array.from(
      atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='),
      c => c.charCodeAt(0),
    )
    const dt = new DataTransfer()
    dt.items.add(new File([png], 'image.png', { type: 'image/png' }))
    if (t) dt.setData('text/plain', t)
    const target = document.activeElement ?? document.body
    target.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
  }, text)
}

test('pasting an image into the chat composer attaches it', async ({ page }) => {
  const uploads: string[] = []
  await mockChatApi(page, uploads)

  await page.goto('/app/chat')
  await page.getByTestId('chat-item-c1').click()
  const input = page.getByTestId('chat-input')
  await expect(input).toBeEnabled()
  await input.focus()

  await pasteImage(page)

  await expect(page.getByTestId('composer-chip-att-1')).toBeVisible()
  expect(uploads[0]).toMatch(/^pasted-\d{14}\.png$/)
  await expect(input).toHaveValue('')
})

test('pasting text into the chat composer does not attach the clipboard image', async ({ page }) => {
  const uploads: string[] = []
  await mockChatApi(page, uploads)

  await page.goto('/app/chat')
  await page.getByTestId('chat-item-c1').click()
  const input = page.getByTestId('chat-input')
  await expect(input).toBeEnabled()
  await input.focus()

  await pasteImage(page, 'some copied text')

  await expect(page.getByTestId('composer-attachments')).toHaveCount(0)
  expect(uploads).toHaveLength(0)
})
