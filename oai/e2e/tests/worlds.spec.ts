import { expect, test } from '@playwright/test'

const now = '2026-11-21T12:00:00Z'
const image = { image_id: '42', filename: 'panorama.png', content_type: 'image/png', width: 1024,
  height: 512, size_bytes: 100, rescaled: false, reencoded: false }
const completed = { job_id: '77', status: 'completed', capability: 'world.splat', mode: 'auto',
  params: null, input_image_id: '42', input_image: image, result: { mode: 'pano', splat_count: 524288,
    depth_range_m: [1.2, 50], timings: { depth_s: 2, splat_s: 1 } }, has_scene: true, has_preview: true,
  ply_bytes: 40 * 2 ** 20, stage: null, error: null, offload_cap: 'world.splat', offload_task_id: 't77',
  started_at: now, typical_runtime_seconds: 30, created_at: now, updated_at: now }

const worldCap = (base: string, tags: string[], raw: string, usage_count = 0) =>
  ({ base, tags, raw, online: true, last_available_at: now, usage_count })

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
    if (path === '/api/worlds/capabilities') return json({ capabilities: [worldCap('world.splat', ['pano'], 'world.splat[pano]')] })
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

test('generates a 2:3 source with a shared starred prompt and builds from the result', async ({ page }) => {
  const picture = { ...image, image_id: '43', filename: 'generated.png', width: 1280, height: 1920 }
  const starredPrompt = 'Lumenport, {misty|sunlit}, {color}, {?}'
  const template = '{.landmark}, {misty|sunlit}, {color}, {?}'
  let imageRequest: unknown
  let worldRequest: unknown
  let recentRequest: unknown
  let completedPicture = false
  await page.setViewportSize({ width: 390, height: 820 })
  await page.addInitScript(() => {
    localStorage.setItem('oai_token', 'test-token')
    localStorage.setItem('oai_image_size', '[1536,1024]')
    localStorage.setItem('oai_world_picture_size', '[1536,1024]')
  })
  await page.route('**/api/**', async route => {
    const { pathname, searchParams } = new URL(route.request().url())
    if (!pathname.startsWith('/api/')) return route.continue()
    const method = route.request().method()
    const json = (body: unknown) => route.fulfill({ json: body })
    if (pathname === '/api/me') return json({ id: 1, login: 'tester', created_at: now, used_storage_bytes: 0 })
    if (pathname === '/api/progress/running') return json({ jobs: [] })
    if (pathname === '/api/worlds/capabilities') return json({ capabilities: [worldCap('world.splat', ['pano'], 'world.splat[pano]')] })
    if (pathname === '/api/worlds/jobs' && method === 'POST') {
      worldRequest = route.request().postDataJSON()
      return json({ job_id: '77', status: 'submitted' })
    }
    if (pathname === '/api/worlds/jobs') return json([])
    if (pathname === '/api/worlds/jobs/77') return json({ ...completed, input_image: picture, input_image_id: picture.image_id,
      result: { ...completed.result, mode: 'perspective' } })
    if (pathname === '/api/images/capabilities') return json(['paint', 'render', 'video'].map(model => {
      const base = `imggen.${model}`
      const tag = model === 'video' ? 'txt2video' : 'txt2img'
      return { base, raw: `${base}[${tag}]`, tags: [tag], online: true, last_available_at: now, usage_count: 0 }
    }))
    if (pathname === '/api/prompts/imggen-prompt/entries' && searchParams.get('kind') === 'starred') return json({
      items: [{ id: '1', content: starredPrompt, kind: 'starred', created_at: now, updated_at: now, last_used_at: now }],
      next_cursor: null,
    })
    if (pathname === '/api/prompts/imggen-prompt/recent') {
      recentRequest = route.request().postDataJSON()
      return json({})
    }
    if (pathname === '/api/prompt-placeholders') return json([{ id: '1', name: '.landmark', variants: ['Lumenport'] }])
    if (pathname === '/api/images/jobs' && method === 'POST') {
      imageRequest = route.request().postDataJSON()
      return json({ job_id: '99', status: 'submitted' })
    }
    if (pathname === '/api/images/jobs/99/poll') return json({
      job_id: '99', status: completedPicture ? 'completed' : 'running', stage: null, error: null,
      output_images: completedPicture ? [picture] : [],
    })
    if (pathname === '/api/images/files/43') return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="128" height="192"/>' })
    return route.fulfill({ status: 404 })
  })

  await page.goto('/app/worlds')
  await page.getByTestId('worlds-generate-open').click()
  await expect(page.getByTestId('worlds-generate-submit')).toBeDisabled()
  await expect(page.getByTestId('worlds-image-upscale')).not.toBeChecked()
  await expect(page.getByTestId('worlds-upscale-model')).toHaveCount(0)
  const presets = page.getByTestId('worlds-image-sizes').getByRole('button')
  await expect(presets).toHaveText(['1024×1536', '1280×1920'])
  await expect(presets.first()).toHaveAttribute('aria-pressed', 'true')
  await presets.last().click()
  await page.getByTestId('worlds-image-model-trigger').click()
  await expect(page.getByTestId('worlds-image-model-option-imggen.video')).toHaveCount(0)
  await page.getByTestId('worlds-image-model-option-imggen.render').click()
  await page.getByTestId('worlds-starred-prompts-open').click()
  await page.getByTestId('prompt-starred-1').getByText(starredPrompt, { exact: true }).click()
  await expect(page.getByTestId('worlds-prompt')).toHaveValue(starredPrompt)
  await page.getByTestId('worlds-reverse-substitutions').click()
  await expect(page.getByTestId('worlds-prompt')).toHaveValue(template)
  await page.getByTestId('worlds-generate-submit').click()
  await expect.poll(() => imageRequest).toMatchObject({
    capability: 'imggen.render', workflow: 'txt2img', width: 1280, height: 1920,
    prompt_template: template, prompt: expect.stringMatching(/^Lumenport, (misty|sunlit), [^{}]+, \{\?\}$/),
  })
  expect(imageRequest).not.toHaveProperty('upscale')
  await expect.poll(() => recentRequest).toMatchObject({ content: template })
  await expect(page.getByTestId('worlds-generate-progress')).toBeVisible()
  await page.getByRole('button', { name: 'Continue in background' }).click()
  await expect(page.getByTestId('worlds-submit')).toBeDisabled()
  completedPicture = true
  await page.getByTestId('worlds-generate-open').click()
  await expect(page.getByTestId('worlds-generated-picture')).toHaveAttribute('src', /\/api\/images\/files\/43/)
  await page.getByTestId('worlds-use-picture').click()
  await expect(page.getByTestId('worlds-mode-hint')).toContainText('1280×1920')
  await page.getByTestId('worlds-submit').click()
  await expect.poll(() => worldRequest).toMatchObject({ capability: 'world.splat', input_image_id: '43', mode: 'auto' })
})

test('generates a world picture with the selected upscaler and multiplier', async ({ page }) => {
  let request: unknown
  const upscaleOutput = { ...image, image_id: '44', width: 3072, height: 4608 }
  await page.addInitScript(() => localStorage.setItem('oai_token', 'test-token'))
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname
    if (!path.startsWith('/api/')) return route.continue()
    const json = (body: unknown) => route.fulfill({ json: body })
    if (path === '/api/me') return json({ id: 1, login: 'tester', created_at: now, used_storage_bytes: 0 })
    if (path === '/api/progress/running') return json({ jobs: [] })
    if (path === '/api/worlds/capabilities') return json({ capabilities: [worldCap('world.splat', ['pano'], 'world.splat[pano]')] })
    if (path === '/api/worlds/jobs') return json([])
    if (path === '/api/images/capabilities') return json([
      { base: 'imggen.paint', raw: 'imggen.paint[txt2img]', tags: ['txt2img'], online: true, last_available_at: now, usage_count: 0 },
    ])
    if (path === '/api/img-utils/capabilities') return json({ capabilities: [
      { base: 'img-utils.restore', utility: 'restore', workflows: ['upscale_refine', 'face_swap'], kind: 'comfy',
        online: true, last_available_at: now, upscale_usage: { upscale_refine: 1 } },
      { base: 'img-utils.seedvr2', utility: 'seedvr2', workflows: ['upscale'], kind: 'comfy',
        online: true, last_available_at: now, upscale_usage: { upscale: 5 } },
      { base: 'img-utils.lotus', utility: 'lotus', workflows: ['depth'], kind: 'comfy',
        online: true, last_available_at: now, upscale_usage: {} },
    ] })
    if (path === '/api/prompt-placeholders') return json([])
    if (path === '/api/prompts/imggen-prompt/recent') return json({})
    if (path === '/api/images/jobs' && route.request().method() === 'POST') {
      request = route.request().postDataJSON()
      return json({ job_id: '100', status: 'submitted' })
    }
    if (path === '/api/images/jobs/100/poll') return json({
      job_id: '100', status: 'completed', stage: null, error: null, output_images: [upscaleOutput],
    })
    if (path === '/api/images/files/44') return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="128" height="192"/>' })
    return route.fulfill({ status: 404 })
  })

  await page.goto('/app/worlds')
  await page.getByTestId('worlds-generate-open').click()
  await page.getByTestId('worlds-prompt').fill('A valley')
  await page.getByTestId('worlds-image-upscale').check()
  await expect(page.getByTestId('worlds-upscale-scale')).toHaveValue('2')
  // The most used upscaler comes first and is preselected.
  const trigger = page.getByTestId('worlds-upscale-model-trigger')
  await expect(trigger).toContainText('Seedvr2')
  await trigger.click()
  const options = page.getByTestId('worlds-upscale-model-list').getByRole('button')
  await expect(options).toHaveText(['Seedvr2', 'Restore · Upscale refine'])
  await options.last().click()
  await page.getByTestId('worlds-upscale-scale').selectOption('3')
  await page.getByTestId('worlds-generate-submit').click()
  await expect.poll(() => request).toMatchObject({
    width: 1024, height: 1536, upscale: { capability: 'img-utils.restore', workflow: 'upscale_refine', scale: 3 },
  })
  await expect(page.getByTestId('worlds-generated-picture')).toHaveAttribute('src', /\/api\/images\/files\/44/)
  await page.getByTestId('worlds-use-picture').click()
  await expect(page.getByTestId('worlds-mode-hint')).toContainText('3072×4608')
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
      worldCap('world.sharp', ['ply', 'preview', 'metric'], 'world.sharp[ply;preview;metric]'),
      worldCap('world.splat', ['pano'], 'world.splat[pano]'),
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
  await expect(page.getByTestId('worlds-capability-trigger')).toContainText('Apple SHARP')
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
  await page.getByTestId('worlds-capability-trigger').click()
  await page.getByTestId('worlds-capability-option-world.splat').click()
  await expect(page.getByTestId('worlds-mode')).toBeVisible()
  await expect(page.getByTestId('worlds-lean')).toBeVisible()
})

test('WorldGen 360° generator asks for surroundings and camera tilt, not projection', async ({ page }) => {
  let submitted: unknown
  const photo = { ...image, filename: 'torii.png', width: 1080, height: 1920 }
  await page.addInitScript(() => localStorage.setItem('oai_token', 'test-token'))
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname
    if (!path.startsWith('/api/')) return route.continue()
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body })
    if (path === '/api/me') return json({ id: 1, login: 'tester', created_at: now, used_storage_bytes: 0 })
    if (path === '/api/admin/am_i_admin') return json({ is_admin: false })
    if (path === '/api/progress/running') return json({ jobs: [] })
    if (path === '/api/worlds/capabilities') return json({ capabilities: [
      worldCap('world.pano360', ['ply', 'preview', 'pano', 'outpaint'], 'world.pano360[ply;preview;pano;outpaint]'),
      worldCap('world.splat', ['pano'], 'world.splat[pano]'),
    ] })
    if (path === '/api/files/images') return json({ files: [{ ...photo, id: '42', direction: 'input' }], has_more: false })
    if (path === '/api/worlds/jobs' && route.request().method() === 'POST') {
      submitted = route.request().postDataJSON()
      return json({ job_id: '79', status: 'submitted' }, 201)
    }
    if (path === '/api/worlds/jobs') return json([])
    if (path === '/api/worlds/jobs/79') return json({ ...completed, job_id: '79', capability: 'world.pano360',
      mode: 'perspective', input_image: photo, result: { mode: 'pano', generator: 'worldgen-flux-pano-v1',
        splat_count: 1211728, splats_bg: 32080, coverage: 0.0824, depth_range_m: [1.2, 49.2],
        settings: { hfov: 60, pitch: -15, prompt: 'a quiet shrine courtyard' } } })
    return route.fulfill({ status: 404 })
  })
  await page.goto('/app/worlds')
  await expect(page.getByTestId('worlds-capability-trigger')).toContainText('WorldGen 360°')
  await expect(page.getByTestId('worlds-generator-hint')).toContainText('rest of the sphere')
  await expect(page.getByTestId('worlds-mode')).toHaveCount(0)
  await expect(page.getByTestId('worlds-lean')).toBeVisible()
  await expect(page.getByTestId('worlds-budget-quest')).toBeVisible()
  await page.getByTestId('worlds-input-pick-library').click()
  await page.getByTestId('imggen-picker-file-42').click()
  await page.getByTestId('imggen-picker-confirm').click()
  await page.getByTestId('worlds-scene-prompt').fill('  a quiet shrine courtyard  ')
  await page.getByTestId('worlds-pitch').selectOption('-15')
  await page.getByTestId('worlds-fov').selectOption('55')
  await page.getByTestId('worlds-submit').click()
  await expect.poll(() => submitted).toEqual({
    capability: 'world.pano360', input_image_id: '42', mode: 'perspective', max_width: 1024, fill_lean: 0.25,
    prompt: 'a quiet shrine courtyard', pitch: -15, hfov: 55,
  })
  await expect(page.getByTestId('worlds-result-summary')).toContainText('covers 8% of the sphere')
  await expect(page.getByTestId('worlds-result-prompt')).toContainText('a quiet shrine courtyard')

  // A level shot with no description sends neither knob: the server fills the prompt in.
  await page.getByTestId('worlds-new-panel-btn').click()
  await page.getByTestId('worlds-scene-prompt').fill('')
  await page.getByTestId('worlds-pitch').selectOption('0')
  await page.getByTestId('worlds-input-pick-library').click()
  await page.getByTestId('imggen-picker-file-42').click()
  await page.getByTestId('imggen-picker-confirm').click()
  await page.getByTestId('worlds-submit').click()
  await expect.poll(() => submitted).toEqual({
    capability: 'world.pano360', input_image_id: '42', mode: 'perspective', max_width: 1024, fill_lean: 0.25, hfov: 55,
  })
})

test('generator picker lists the most used first and preselects the latest world\'s one', async ({ page }) => {
  let jobs: unknown[] = []
  await page.addInitScript(() => localStorage.setItem('oai_token', 'test-token'))
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname
    if (!path.startsWith('/api/')) return route.continue()
    const json = (body: unknown) => route.fulfill({ json: body })
    if (path === '/api/me') return json({ id: 1, login: 'tester', created_at: now, used_storage_bytes: 0 })
    if (path === '/api/progress/running') return json({ jobs: [] })
    if (path === '/api/worlds/capabilities') return json({ capabilities: [
      worldCap('world.pano360', [], 'world.pano360', 1),
      worldCap('world.sharp', [], 'world.sharp', 0),
      worldCap('world.splat', [], 'world.splat', 7),
    ] })
    if (path === '/api/worlds/jobs') return json(jobs)
    return route.fulfill({ status: 404 })
  })

  // No history: the most used generator is selected and heads the list.
  await page.goto('/app/worlds')
  const trigger = page.getByTestId('worlds-capability-trigger')
  await expect(trigger).toContainText('Lotus depth')
  await expect(page.getByTestId('worlds-new-panel').locator('select#worlds-capability')).toHaveCount(0)
  await trigger.click()
  await expect(page.getByTestId('worlds-capability-list').getByRole('button'))
    .toHaveText([/Lotus depth/, /WorldGen 360°/, /Apple SHARP/])

  // The latest world's generator wins over the usage ranking.
  jobs = [completed].map(job => ({ ...job, capability: 'world.pano360' }))
  await page.reload()
  await expect(page.getByTestId('worlds-capability-trigger')).toContainText('WorldGen 360°')
})

test('experimental WorldMirror is never preselected and offers only its clean-up filters', async ({ page }) => {
  let submitted: unknown
  const photo = { ...image, filename: 'torii.png', width: 1080, height: 1920 }
  await page.addInitScript(() => localStorage.setItem('oai_token', 'test-token'))
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname
    if (!path.startsWith('/api/')) return route.continue()
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body })
    if (path === '/api/me') return json({ id: 1, login: 'tester', created_at: now, used_storage_bytes: 0 })
    if (path === '/api/admin/am_i_admin') return json({ is_admin: false })
    if (path === '/api/progress/running') return json({ jobs: [] })
    if (path === '/api/worlds/capabilities') return json({ capabilities: [
      worldCap('world.mirror', ['ply', 'preview', 'experimental'], 'world.mirror[ply;preview;experimental]'),
      worldCap('world.sharp', ['ply', 'preview', 'metric'], 'world.sharp[ply;preview;metric]'),
    ] })
    if (path === '/api/files/images') return json({ files: [{ ...photo, id: '42', direction: 'input' }], has_more: false })
    if (path === '/api/worlds/jobs' && route.request().method() === 'POST') {
      submitted = route.request().postDataJSON()
      return json({ job_id: '80', status: 'submitted' }, 201)
    }
    if (path === '/api/worlds/jobs') return json([])
    if (path === '/api/worlds/jobs/80') return json({ ...completed, job_id: '80', capability: 'world.mirror',
      mode: 'perspective', input_image: photo, result: { mode: 'perspective', generator: 'hy-worldmirror-2.0',
        splat_count: 496334, depth_range_m: [3.4, 26.6], settings: { hfov: 31.8, scale_source: 'median' } } })
    return route.fulfill({ status: 404 })
  })
  await page.goto('/app/worlds')
  await expect(page.getByTestId('worlds-capability-trigger')).toContainText('Apple SHARP')
  await page.getByTestId('worlds-capability-trigger').click()
  await page.getByTestId('worlds-capability-option-world.mirror').click()
  await expect(page.getByTestId('worlds-generator-hint')).toContainText('does not cover the EU')
  for (const id of ['worlds-fov', 'worlds-mode', 'worlds-lean', 'worlds-budget-quest']) {
    await expect(page.getByTestId(id)).toHaveCount(0)
  }
  await page.getByTestId('worlds-input-pick-library').click()
  await page.getByTestId('imggen-picker-file-42').click()
  await page.getByTestId('imggen-picker-confirm').click()
  await page.getByTestId('worlds-submit').click()
  await expect.poll(() => submitted).toEqual({ capability: 'world.mirror', input_image_id: '42', mode: 'perspective' })
  await expect(page.getByTestId('worlds-result-summary')).toContainText('scale estimated')

  await page.getByTestId('worlds-new-panel-btn').click()
  await page.getByTestId('worlds-capability-trigger').click()
  await page.getByTestId('worlds-capability-option-world.mirror').click()
  await page.getByTestId('worlds-cleanup').check()
  await page.getByTestId('worlds-input-pick-library').click()
  await page.getByTestId('imggen-picker-file-42').click()
  await page.getByTestId('imggen-picker-confirm').click()
  await page.getByTestId('worlds-submit').click()
  await expect.poll(() => submitted).toEqual({
    capability: 'world.mirror', input_image_id: '42', mode: 'perspective', cleanup: true,
  })
})
