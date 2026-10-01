import { expect, test, type Page } from '@playwright/test'

const now = '2026-09-30T12:00:00Z'

async function mockDescribeApi(page: Page, uploads: string[]) {
  await page.addInitScript(() => localStorage.setItem('oai_token', 'test-token'))
  await page.route('**/api/**', async route => {
    const { pathname } = new URL(route.request().url())
    if (!pathname.startsWith('/api/')) return route.continue()
    const method = route.request().method()
    const json = (body: unknown) => route.fulfill({ json: body })

    if (pathname === '/api/me') {
      return json({ id: 1, login: 'tester', google_id: null, created_at: now, used_storage_bytes: 0 })
    }
    if (pathname === '/api/describe/jobs' && method === 'GET') return json([])
    if (pathname === '/api/describe/capabilities') return json({ capabilities: [] })
    if (pathname === '/api/images/external-resize') return json({ available: false, threshold_bytes: 0 })
    if (pathname === '/api/images/upload' && method === 'POST') {
      const body = route.request().postDataBuffer()?.toString('latin1') ?? ''
      const filename = /filename="([^"]+)"/.exec(body)?.[1] ?? ''
      uploads.push(filename)
      return json({
        image_id: '42',
        filename,
        content_type: 'image/png',
        width: 1,
        height: 1,
        size_bytes: 68,
        rescaled: false,
        reencoded: false,
      })
    }
    if (pathname === '/api/progress/running') return json({ jobs: [] })
    if (pathname.startsWith('/api/prompts/')) return json({})
    return route.fulfill({ status: 404, json: { error: 'Not mocked' } })
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

test('pasting an image on the New analysis panel uploads it as the input', async ({ page }) => {
  const uploads: string[] = []
  await mockDescribeApi(page, uploads)

  await page.goto('/app/describe')
  await expect(page.getByTestId('describe-drop-zone')).toBeVisible()

  await pasteImage(page)

  await expect(page.getByTestId('describe-image-preview')).toBeVisible()
  expect(uploads).toHaveLength(1)
  expect(uploads[0]).toMatch(/^pasted-\d{14}\.png$/)
})

test('pasting text into the prompt does not grab the clipboard image', async ({ page }) => {
  const uploads: string[] = []
  await mockDescribeApi(page, uploads)

  await page.goto('/app/describe')
  await page.getByTestId('describe-prompt-input').focus()
  await pasteImage(page, 'copied paragraph from a document')

  await expect(page.getByTestId('describe-drop-zone')).toBeVisible()
  expect(uploads).toHaveLength(0)
})
