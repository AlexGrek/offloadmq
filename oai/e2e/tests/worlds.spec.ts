import { expect, test } from '@playwright/test'

const now = '2026-11-21T12:00:00Z'
const image = { image_id: '42', filename: 'panorama.png', content_type: 'image/png', width: 1024,
  height: 512, size_bytes: 100, rescaled: false, reencoded: false }
const completed = { job_id: '77', status: 'completed', capability: 'world.splat', mode: 'auto',
  params: null, input_image_id: '42', input_image: image, result: { mode: 'pano', splat_count: 524288,
    depth_range_m: [1.2, 50], timings: { depth_s: 2, splat_s: 1 } }, has_scene: true, has_preview: true,
  ply_bytes: 40 * 2 ** 20, stage: null, error: null, offload_cap: 'world.splat', offload_task_id: 't77',
  started_at: now, typical_runtime_seconds: 30, created_at: now, updated_at: now }

test('library input, submission, detail, headset sharing and deletion', async ({ page }) => {
  let jobs = [completed]
  let submitted: unknown
  await page.addInitScript(() => localStorage.setItem('oai_token', 'test-token'))
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname
    if (!path.startsWith('/api/')) return route.continue()
    const method = route.request().method()
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body })
    if (path === '/api/me') return json({ id: 1, login: 'tester', created_at: now, used_storage_bytes: 0 })
    if (path === '/api/admin/am_i_admin') return json({ is_admin: false })
    if (path === '/api/progress/running') return json({ jobs: [] })
    if (path === '/api/worlds/capabilities') return json({ capabilities: [{ base: 'world.splat', tags: ['pano'], raw: 'world.splat[pano]' }] })
    if (path === '/api/files/images') return json({ files: [{ ...image, id: '42', direction: 'input' }], has_more: false })
    if (path === '/api/worlds/jobs' && method === 'POST') {
      submitted = route.request().postDataJSON()
      return json({ job_id: '77', status: 'submitted' }, 201)
    }
    if (path === '/api/worlds/jobs') return json(jobs)
    if (path === '/api/worlds/jobs/77/share') return json({ viewer_url: 'https://example.test/worlds/view/77?u=1&exp=9999999999&sig=test', expires_at: '2099-01-01T00:00:00Z' })
    if (path === '/api/worlds/jobs/77' && method === 'DELETE') { jobs = []; return route.fulfill({ status: 204 }) }
    if (path === '/api/worlds/jobs/77') return json(completed)
    return route.fulfill({ status: 404 })
  })
  await page.goto('/app/worlds')
  await expect(page.getByTestId('worlds-new-panel')).toBeVisible()
  await expect(page.getByTestId('worlds-item-77')).toContainText('0.52 M splats')
  await expect(page.getByTestId('worlds-submit')).toBeDisabled()
  await page.getByTestId('worlds-input-pick-library').click()
  await expect(page.getByTestId('imggen-image-picker-modal')).toBeVisible()
  await page.getByTestId('imggen-picker-file-42').click()
  await page.getByTestId('imggen-picker-confirm').click()
  await expect(page.getByTestId('worlds-mode-hint')).toContainText('360')
  await page.getByTestId('worlds-submit').click()
  await expect.poll(() => submitted).toEqual({ capability: 'world.splat', input_image_id: '42', mode: 'auto', max_width: 1024, fill_lean: 0.25 })
  await expect(page.getByTestId('worlds-result-summary')).toContainText('40.0 MiB')
  // Opening the job only fetches its preview; the large scene is opt-in.
  await expect(page.getByTestId('worlds-viewer')).toHaveCount(0)
  await page.getByTestId('worlds-share').click()
  await expect(page.getByTestId('worlds-share-url')).toHaveValue(/worlds\/view\/77/)
  await page.getByTestId('worlds-delete-job').click()
  await expect(page.getByTestId('worlds-new-panel')).toBeVisible()
  await expect(page.getByTestId('worlds-item-77')).toHaveCount(0)
})

test('public viewer needs no login and rejects incomplete or expired links', async ({ page }) => {
  await page.goto('/worlds/view/77')
  await expect(page.getByText('This world link is incomplete.', { exact: false })).toBeVisible()
  await page.goto('/worlds/view/77?u=1&exp=1&sig=bad')
  await expect(page.getByText('This world link has expired.', { exact: false })).toBeVisible()
  await page.goto('/worlds/view/77?u=1&exp=invalid&sig=bad')
  await expect(page.getByText('This world link has expired.', { exact: false })).toBeVisible()
})

test('signed public viewer mounts its 3D controls without authentication', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'xr', { configurable: true, value: {
      isSessionSupported: async () => true,
      addEventListener: () => {}, removeEventListener: () => {},
    } })
  })
  await page.route('**/api/worlds/public/**', route => route.fulfill({ status: 403 }))
  await page.goto('/worlds/view/77?u=1&exp=9999999999&sig=bad')
  await expect(page.getByTestId('worlds-viewer')).toBeVisible()
  await expect(page.getByTestId('worlds-viewer-recenter')).toBeVisible()
  await expect(page.getByTestId('worlds-enter-vr')).toBeVisible()
  await expect(page.getByText('Could not load this world:', { exact: false })).toBeVisible()
})

test('SHARP generator hides depth knobs and submits only the chosen field of view', async ({ page }) => {
  let submitted: unknown
  const photo = { ...image, filename: 'temple.png', width: 1536, height: 1536 }
  await page.addInitScript(() => localStorage.setItem('oai_token', 'test-token'))
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname
    if (!path.startsWith('/api/')) return route.continue()
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body })
    if (path === '/api/me') return json({ id: 1, login: 'tester', created_at: now, used_storage_bytes: 0 })
    if (path === '/api/admin/am_i_admin') return json({ is_admin: false })
    if (path === '/api/progress/running') return json({ jobs: [] })
    if (path === '/api/worlds/capabilities') return json({ capabilities: [
      { base: 'world.sharp', tags: ['ply', 'preview', 'metric'], raw: 'world.sharp[ply;preview;metric]' },
      { base: 'world.splat', tags: ['pano'], raw: 'world.splat[pano]' },
    ] })
    if (path === '/api/files/images') return json({ files: [{ ...photo, id: '42', direction: 'input' }], has_more: false })
    if (path === '/api/worlds/jobs' && route.request().method() === 'POST') {
      submitted = route.request().postDataJSON()
      return json({ job_id: '78', status: 'submitted' }, 201)
    }
    if (path === '/api/worlds/jobs') return json([])
    if (path === '/api/worlds/jobs/78') return json({ ...completed, job_id: '78', capability: 'world.sharp',
      mode: 'perspective', input_image: photo, result: { mode: 'perspective', generator: 'apple-sharp',
        splat_count: 1179648, depth_range_m: [2.1, 13.7], settings: { hfov: 55 } } })
    return route.fulfill({ status: 404 })
  })
  await page.goto('/app/worlds')
  await expect(page.getByTestId('worlds-capability')).toHaveValue('world.sharp')
  await expect(page.getByTestId('worlds-capability')).toContainText('Apple SHARP')
  await expect(page.getByTestId('worlds-generator-hint')).toContainText('no 360°')
  await expect(page.getByTestId('worlds-mode')).toHaveCount(0)
  await expect(page.getByTestId('worlds-lean')).toHaveCount(0)
  await page.getByTestId('worlds-input-pick-library').click()
  await page.getByTestId('imggen-picker-file-42').click()
  await page.getByTestId('imggen-picker-confirm').click()
  await page.getByTestId('worlds-fov').selectOption('55')
  await page.getByTestId('worlds-submit').click()
  await expect.poll(() => submitted).toEqual({ capability: 'world.sharp', input_image_id: '42', mode: 'perspective', hfov: 55 })
  await expect(page.getByTestId('worlds-result-summary')).toContainText('55° FOV')

  // Switching back to Lotus restores its knobs.
  await page.getByTestId('worlds-new-panel-btn').click()
  await page.getByTestId('worlds-capability').selectOption('world.splat')
  await expect(page.getByTestId('worlds-mode')).toBeVisible()
  await expect(page.getByTestId('worlds-lean')).toBeVisible()
})
