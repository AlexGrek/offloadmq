import { expect, test } from '@playwright/test'

/**
 * Image Tools → Face swap: "From persona" fills the face reference slot with one of a
 * persona's stored faces (no re-upload). Fully mocked — no backend needed.
 */

const now = '2026-11-08T12:00:00Z'
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
)

const face = (id: string) => ({ image_id: id, filename: `${id}.jpg`, content_type: 'image/jpeg', width: 512, height: 512 })
const persona = (id: string, name: string, faces: string[]) => ({
  id, name, system_prompt: '', rendered_system_prompt: '', look: '',
  face_image_ids: faces, faces: faces.map(face),
  llm_capability: null, txt2img_capability: null, img2img_capability: null,
  face_swap_capability: null, upscaler_capability: null, created_at: now, updated_at: now,
})

async function mockApi(page: import('@playwright/test').Page, personas: unknown[]) {
  const state = { starts: [] as Record<string, unknown>[] }
  await page.addInitScript(() => localStorage.setItem('oai_token', 'test-token'))
  await page.route('**/api/**', async route => {
    const { pathname } = new URL(route.request().url())
    // The glob also matches Vite's own /src/api/*.ts modules.
    if (!pathname.startsWith('/api/')) return route.continue()
    const method = route.request().method()
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body })
    if (pathname === '/api/admin/am_i_admin') return json({ is_admin: false })
    if (pathname === '/api/me') return json({ id: 1, login: 'tester', google_id: null, created_at: now, used_storage_bytes: 0 })
    if (pathname === '/api/progress/running') return json({ jobs: [] })
    if (pathname === '/api/img-utils/capabilities') {
      return json({
        capabilities: [{
          base: 'img-utils.reactor', utility: 'reactor', workflows: ['face_swap'], raw: 'img-utils.reactor[face_swap]',
          needs_source_image: true, kind: 'comfy', methods: [],
        }],
      })
    }
    if (pathname === '/api/img-utils/jobs' && method === 'GET') return json([])
    if (pathname === '/api/img-utils/jobs' && method === 'POST') {
      state.starts.push(route.request().postDataJSON())
      return json({ job_id: '9', status: 'submitted' }, 201)
    }
    if (pathname === '/api/personas' && method === 'GET') return json(personas)
    if (pathname === '/api/images/upload') {
      return json({ image_id: 'target-1', filename: 't.png', content_type: 'image/png', width: 1, height: 1, size_bytes: 70, rescaled: false, reencoded: false })
    }
    if (pathname.startsWith('/api/images/files/')) return route.fulfill({ status: 200, contentType: 'image/png', body: PNG })
    return json({})
  })
  return state
}

test('face reference can be taken from a persona', async ({ page }) => {
  const state = await mockApi(page, [
    persona('p0', 'Faceless', []),
    persona('p1', 'Ada', ['face-a', 'face-b']),
  ])
  await page.goto('/app/img-utils')

  await page.getByTestId('imgutils-input-drop-zone').locator('input').setInputFiles({ name: 't.png', mimeType: 'image/png', buffer: PNG })
  await page.getByTestId('imgutils-source-pick-persona').click()

  // Personas without a face are not offered.
  await expect(page.getByTestId('persona-face-picker-persona-p1')).toBeVisible()
  await expect(page.getByTestId('persona-face-picker-persona-p0')).toHaveCount(0)
  await page.getByTestId('persona-face-pick-face-b').click()

  await expect(page.getByTestId('persona-face-picker-modal')).toHaveCount(0)
  await expect(page.getByTestId('imgutils-source-clear')).toBeVisible()

  const run = page.getByTestId('imgutils-submit')
  await expect(run).toBeEnabled()
  await run.click()
  await expect.poll(() => state.starts.length).toBe(1)
  expect(state.starts[0]).toMatchObject({
    capability: 'img-utils.reactor',
    workflow: 'face_swap',
    input_image_id: 'target-1',
    source_image_id: 'face-b',
  })
})

test('persona picker explains when there is nothing to pick', async ({ page }) => {
  await mockApi(page, [persona('p0', 'Faceless', [])])
  await page.goto('/app/img-utils')
  await page.getByTestId('imgutils-source-pick-persona').click()
  await expect(page.getByTestId('persona-face-picker-empty')).toContainText('None of your personas has a face image yet')
  await page.getByTestId('persona-face-picker-cancel').click()
  await expect(page.getByTestId('persona-face-picker-modal')).toHaveCount(0)
})
