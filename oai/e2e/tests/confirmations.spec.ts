import { expect, test, type Page } from '@playwright/test'

const now = '2026-11-20T12:00:00Z'
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

function mediaFile(id: string, kind: 'image' | 'video' | 'audio') {
  return {
    id, kind: kind === 'audio' ? 'audio' : 'image', direction: 'output', source: 'generated',
    filename: `${id}.${kind === 'audio' ? 'mp3' : kind === 'video' ? 'mp4' : 'png'}`,
    content_type: `${kind}/${kind === 'image' ? 'png' : kind === 'audio' ? 'mpeg' : 'mp4'}`,
    width: 512, height: 512, size_bytes: 100, sha256: '', job_id: id, created_at: now,
    url: `/api/images/files/${id}`, thumbnail_url: `/api/images/files/${id}/thumbnail`,
    is_image: kind === 'image', is_video: kind === 'video', is_audio: kind === 'audio', is_starred: false,
  }
}

async function mockApi(page: Page) {
  const mutations: { path: string; body: unknown }[] = []
  const nativeDialogs: string[] = []
  let failNext = false
  page.on('pageerror', error => { throw error })
  await page.addInitScript(() => localStorage.setItem('oai_token', 'test-token'))
  page.on('dialog', async dialog => {
    nativeDialogs.push(dialog.type())
    await dialog.dismiss()
  })
  await page.routeWebSocket('**/api/ws/chat*', ws => {
    ws.onMessage(raw => {
      const msg = JSON.parse(String(raw))
      if (msg.type === 'list_capabilities') ws.send(JSON.stringify({ type: 'capabilities', req_id: msg.req_id, capabilities: [] }))
    })
  })
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname
    if (!path.startsWith('/api/')) return route.continue()
    const method = route.request().method()
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body })
    if (method === 'DELETE' || path === '/api/files/cleanup') {
      mutations.push({ path, body: route.request().postDataJSON() })
      if (failNext) {
        failNext = false
        return json({ error: 'Deletion failed' }, 500)
      }
      return json(path === '/api/files/cleanup' ? { deleted_count: 3, skipped_starred: 1 } : {})
    }
    if (path === '/api/me') return json({ id: 1, login: 'tester', google_id: null, created_at: now, used_storage_bytes: 0 })
    if (path === '/api/admin/am_i_admin') return json({ is_admin: false })
    if (path === '/api/progress/running') return json({ jobs: [] })
    if (path === '/api/prompt-placeholders') return json([{ id: 'p1', name: '.cinematic', variants: ['film'] }])
    if (path === '/api/files') return json({
      files: [mediaFile('img', 'image'), mediaFile('vid', 'video'), mediaFile('audio', 'audio')],
      summary: { used_bytes: 300, file_count: 3, input_bytes: 0, output_bytes: 300 },
    })
    if (path.endsWith('/starred')) return json({ starred: false })
    if (path.startsWith('/api/images/files/')) return route.fulfill({ body: PNG, contentType: 'image/png' })
    if (path === '/api/chats') return json([{ id: 'c1', title: 'A chat', system_prompt: 'Helpful', kind: 'chat', created_at: now, updated_at: now }])
    if (path.endsWith('/messages')) return json([])
    if (path.startsWith('/api/prompts/')) return json({ items: [{ id: 's1', kind: 'starred', content: 'A fox', created_at: now, updated_at: now, last_used_at: now, preview_version: null }], next_cursor: null })
    if (path === '/api/images/capabilities' || path === '/api/images/jobs' || path === '/api/images/stash') return json([])
    if (path === '/api/images/external-resize') return json({ available: false, threshold_bytes: 0 })
    return json({})
  })
  return { mutations, nativeDialogs, failNext: () => { failNext = true } }
}

test('placeholder deletion cancels safely, focuses Cancel, and confirms above the drawer on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const api = await mockApi(page)
  await page.goto('/app/dashboard')
  await page.getByTestId('random-names-toggle').click()
  const remove = page.getByTestId('prompt-placeholders-delete-p1')
  await remove.click()
  await expect(page.getByRole('alertdialog')).toContainText('{.cinematic}')
  await expect(page.getByTestId('confirmation-cancel')).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('confirmation-dialog')).toHaveCount(0)
  await expect(remove).toBeFocused()
  expect(api.mutations).toHaveLength(0)
  await expect(page.getByTestId('prompt-placeholders-drawer')).toBeVisible()
  await remove.click()
  await page.getByTestId('confirmation-accept').click()
  await expect.poll(() => api.mutations.length).toBe(1)
  expect(api.mutations[0].path).toBe('/api/prompt-placeholders/p1')
  expect(api.nativeDialogs).toEqual([])
})

for (const [id, title] of [['img', 'Delete image?'], ['vid', 'Delete video?']] as const) {
  test(`${title} stacks above the lightbox and preserves it on cancel or API failure`, async ({ page }) => {
    const api = await mockApi(page)
    await page.goto('/app/files')
    await page.locator(`button[data-testid="file-tile-${id}"]`).click()
    const remove = page.getByTestId(`file-tile-${id}-delete`)
    await remove.click()
    await expect(page.getByRole('alertdialog')).toContainText(title)
    await page.getByTestId('confirmation-cancel').click()
    expect(api.mutations).toHaveLength(0)
    await expect(page.getByTestId(`file-tile-${id}-lightbox`)).toBeVisible()
    api.failNext()
    await remove.click()
    await page.getByTestId('confirmation-accept').click()
    await expect(page.getByTestId(`file-tile-${id}-lightbox-error`)).toHaveText('Deletion failed')
    await remove.click()
    await page.getByTestId('confirmation-accept').click()
    await expect(page.getByTestId(`file-tile-${id}-lightbox`)).toHaveCount(0)
    expect(api.mutations.map(m => m.path)).toEqual([`/api/images/files/${id}`, `/api/images/files/${id}`])
    expect(api.nativeDialogs).toEqual([])
  })
}

test('audio deletion only sends a request after confirmation', async ({ page }) => {
  const api = await mockApi(page)
  await page.goto('/app/files')
  await page.getByTestId('files-audio-delete-audio').click()
  await page.getByTestId('confirmation-cancel').click()
  expect(api.mutations).toHaveLength(0)
  await page.getByTestId('files-audio-delete-audio').click()
  await page.getByTestId('confirmation-accept').click()
  await expect.poll(() => api.mutations.length).toBe(1)
  expect(api.mutations[0].path).toBe('/api/tts/jobs/audio')
  expect(api.nativeDialogs).toEqual([])
})

test('bulk cleanup confirms the selected scope and starred policy and keeps errors visible', async ({ page }) => {
  const api = await mockApi(page)
  await page.goto('/app/files')
  await page.getByTestId('files-cleanup-open').click()
  await page.getByTestId('files-cleanup-uploads').click()
  await expect(page.getByRole('alertdialog')).toContainText('except starred items')
  await page.getByTestId('confirmation-cancel').click()
  expect(api.mutations).toHaveLength(0)
  await page.getByTestId('files-cleanup-open').click()
  await page.getByTestId('files-cleanup-keep-starred').click()
  await page.getByTestId('files-cleanup-generated').click()
  await expect(page.getByRole('alertdialog')).toContainText('all generated images, including starred items')
  api.failNext()
  await page.getByTestId('confirmation-accept').click()
  await expect(page.getByTestId('files-cleanup-error')).toHaveText('Deletion failed')
  expect(api.mutations[0].body).toEqual({ scope: 'generated', keep_starred: false })
  expect(api.nativeDialogs).toEqual([])
})

test('saved prompt deletion confirms above its sheet', async ({ page }) => {
  const api = await mockApi(page)
  await page.goto('/app/images')
  await page.getByTestId('imggen-starred-prompts-open').click()
  await page.getByTestId('prompt-delete-s1').click()
  await page.getByTestId('confirmation-cancel').click()
  expect(api.mutations).toHaveLength(0)
  await expect(page.getByTestId('prompt-library-drawer')).toBeVisible()
  await page.getByTestId('prompt-delete-s1').click()
  await page.getByTestId('confirmation-accept').click()
  await expect(page.getByTestId('prompt-delete-s1')).toHaveCount(0)
  expect(api.mutations[0].path).toBe('/api/prompt-entries/s1')
  expect(api.nativeDialogs).toEqual([])
})

test('chat deletion confirms before deleting the conversation', async ({ page }) => {
  const api = await mockApi(page)
  await page.goto('/app/chat')
  await page.getByTestId('delete-chat-c1').click()
  await expect(page.getByRole('alertdialog')).toContainText('A chat')
  await page.getByTestId('confirmation-cancel').click()
  expect(api.mutations).toHaveLength(0)
  await page.getByTestId('delete-chat-c1').click()
  await page.getByTestId('confirmation-accept').click()
  await expect(page.getByTestId('delete-chat-c1')).toHaveCount(0)
  expect(api.mutations[0].path).toBe('/api/chats/c1')
  expect(api.nativeDialogs).toEqual([])
})

test('navigating away dismisses a pending confirmation without deleting', async ({ page }) => {
  const api = await mockApi(page)
  await page.goto('/app/files')
  await page.getByTestId('files-audio-delete-audio').click()
  await expect(page.getByTestId('confirmation-dialog')).toBeVisible()
  await page.evaluate(() => {
    history.pushState({}, '', '/app/dashboard')
    dispatchEvent(new PopStateEvent('popstate'))
  })
  await expect(page.getByTestId('confirmation-dialog')).toHaveCount(0)
  expect(api.mutations).toHaveLength(0)
})
