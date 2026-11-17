import { expect, test, type Request } from '@playwright/test'

test('generates a configurable batch from a description and stays on Describe Image', async ({ page }) => {
  const description = 'A red fox resting under a pine tree at dawn.'
  const editedDescription = 'A red fox resting under a pine tree in early morning mist.'
  const now = '2026-09-30T12:00:00Z'
  const describeJob = {
    job_id: 'describe-1',
    status: 'completed',
    prompt: 'Describe this image',
    capability: 'llm.vision',
    input_image_id: null,
    result: description,
    stage: null,
    error: null,
    offload_cap: null,
    offload_task_id: null,
    created_at: now,
    updated_at: now,
  }

  await page.addInitScript(() => localStorage.setItem('oai_token', 'test-token'))
  await page.route('**/api/**', async route => {
    const { pathname } = new URL(route.request().url())
    if (!pathname.startsWith('/api/')) return route.continue()
    const method = route.request().method()
    const json = (body: unknown) => route.fulfill({ json: body })

    if (pathname === '/api/me') {
      return json({ id: 1, login: 'tester', google_id: null, created_at: now, used_storage_bytes: 0 })
    }
    if (pathname === '/api/describe/jobs' && method === 'GET') return json([describeJob])
    if (pathname === '/api/describe/jobs/describe-1' && method === 'GET') return json(describeJob)
    if (pathname === '/api/describe/capabilities') return json({ capabilities: [] })
    if (pathname === '/api/images/external-resize') return json({ available: false, threshold_bytes: 0 })
    if (pathname === '/api/images/capabilities') {
      return json([
        { base: 'imggen.paint', raw: 'imggen.paint[txt2img]', tags: ['txt2img'], online: true, last_available_at: now, usage_count: 0 },
        { base: 'imggen.video', raw: 'imggen.video[txt2video]', tags: ['txt2video'], online: true, last_available_at: now, usage_count: 0 },
      ])
    }
    if (pathname === '/api/images/jobs' && method === 'POST') {
      return json({ job_id: 'image-1', status: 'submitted' })
    }
    if (pathname === '/api/progress/running') return json({ jobs: [] })
    if (pathname === '/api/prompts/imggen-prompt/recent') return json({})
    return route.fulfill({ status: 404, json: { error: 'Not mocked' } })
  })

  await page.goto('/app/describe')
  await page.getByTestId('describe-item-describe-1').click()
  await expect(page.getByTestId('describe-result')).toContainText(description)
  await page.setViewportSize({ width: 375, height: 667 })
  await page.getByTestId('describe-generate-open').click()

  const dialog = page.getByTestId('describe-generate-dialog')
  await expect(dialog).toBeVisible()
  const bounds = await dialog.boundingBox()
  expect(bounds).not.toBeNull()
  expect(bounds!.x).toBeGreaterThanOrEqual(0)
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(375)
  expect(bounds!.y).toBeGreaterThanOrEqual(0)
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(667)
  await expect(page.getByTestId('describe-generate-prompt')).toHaveValue(description)
  // The prompt is pre-filled but not focused — size/model are the usual next step.
  await expect(page.getByTestId('describe-generate-prompt')).not.toBeFocused()
  await page.getByTestId('describe-generate-prompt').fill(editedDescription)
  await expect(page.getByTestId('describe-generate-model')).toHaveValue('imggen.paint')
  await expect(page.getByTestId('describe-generate-model').locator('option')).toHaveCount(1)
  await page.getByTestId('describe-generate-size-1536x1024').click()
  await expect(page.getByTestId('describe-generate-size-1536x1024')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('describe-generate-count')).toHaveValue('1')
  await expect(page.getByTestId('describe-generate-count')).toHaveAttribute('max', '24')
  await page.getByTestId('describe-generate-count').fill('2')

  const submitted: Request[] = []
  page.on('request', request => {
    if (request.url().endsWith('/api/images/jobs') && request.method() === 'POST') submitted.push(request)
  })
  await page.getByTestId('describe-generate-submit').click()
  await expect.poll(() => submitted).toHaveLength(2)
  for (const request of submitted) {
    expect(request.postDataJSON()).toEqual(expect.objectContaining({
      capability: 'imggen.paint',
      prompt: editedDescription,
      prompt_template: editedDescription,
      width: 1536,
      height: 1024,
      workflow: 'txt2img',
    }))
  }
  await expect(dialog).not.toBeVisible()
  await expect(page).toHaveURL(/\/app\/describe$/)
  await expect(page.getByTestId('describe-result')).toContainText(description)
})

test('Generate multiple dialog offers 1 2 3 4 5 8 quick buttons and manual edit up to 24', async ({ page }) => {
  const now = '2026-09-30T12:00:00Z'
  await page.addInitScript(() => localStorage.setItem('oai_token', 'test-token'))
  await page.route('**/api/**', async route => {
    const { pathname } = new URL(route.request().url())
    if (!pathname.startsWith('/api/')) return route.continue()
    const method = route.request().method()
    const json = (body: unknown) => route.fulfill({ json: body })

    if (pathname === '/api/me') {
      return json({ id: 1, login: 'tester', google_id: null, created_at: now, used_storage_bytes: 0 })
    }
    if (pathname === '/api/admin/am_i_admin') return json({ is_admin: false })
    if (pathname === '/api/admin/settings') return json({ client_api_token: 'tok' })
    if (pathname === '/api/images/external-resize') return json({ available: false, threshold_bytes: 0 })
    if (pathname === '/api/images/capabilities') {
      return json([
        { base: 'imggen.paint', raw: 'imggen.paint[txt2img]', tags: ['txt2img'], online: true, last_available_at: now, usage_count: 0 },
      ])
    }
    if (pathname === '/api/images/jobs' && method === 'GET') return json([])
    if (pathname === '/api/images/stash') return json([])
    if (pathname === '/api/progress/running') return json({ jobs: [] })
    if (pathname.startsWith('/api/prompts/')) return json({})
    return route.fulfill({ status: 404, json: { error: 'Not mocked' } })
  })

  await page.goto('/app/images')
  await page.getByTestId('imggen-generate-multiple-open').click()

  const dialog = page.getByTestId('imggen-generate-multiple-dialog')
  await expect(dialog).toBeVisible()

  const presets = [1, 2, 3, 4, 5, 8]
  for (const n of presets) {
    await expect(page.getByTestId(`imggen-generate-multiple-preset-${n}`)).toHaveText(String(n))
  }
  const input = page.getByTestId('imggen-generate-multiple-count')
  await expect(input).toHaveValue('4')
  await expect(input).toHaveAttribute('max', '24')
  await expect(page.getByTestId('imggen-generate-multiple-preset-4')).toHaveAttribute('aria-pressed', 'true')

  // Clicking a quick button updates the input and submit label.
  await page.getByTestId('imggen-generate-multiple-preset-8').click()
  await expect(input).toHaveValue('8')
  await expect(page.getByTestId('imggen-generate-multiple-preset-8')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('imggen-generate-multiple-preset-4')).toHaveAttribute('aria-pressed', 'false')
  await expect(page.getByTestId('imggen-generate-multiple-submit')).toHaveText('Generate 8 images')

  // Manual edit up to 24 (and clamping above 24 on blur).
  await input.fill('24')
  await expect(page.getByTestId('imggen-generate-multiple-submit')).toHaveText('Generate 24 images')
  await input.fill('30')
  await input.blur()
  await expect(input).toHaveValue('24')
  await expect(page.getByTestId('imggen-generate-multiple-submit')).toHaveText('Generate 24 images')
})

test('editing a description keeps its original image selected', async ({ page }) => {
  const now = '2026-09-30T12:00:00Z'
  const describeJob = {
    job_id: 'describe-1',
    status: 'completed',
    prompt: 'Describe this image',
    capability: 'llm.vision',
    input_image_id: 'image-42',
    result: 'A red fox resting under a pine tree at dawn.',
    stage: null,
    error: null,
    offload_cap: null,
    offload_task_id: null,
    created_at: now,
    updated_at: now,
  }
  const submissions: unknown[] = []

  await page.addInitScript(() => localStorage.setItem('oai_token', 'test-token'))
  await page.route('**/api/**', async route => {
    const { pathname } = new URL(route.request().url())
    if (!pathname.startsWith('/api/')) return route.continue()
    const method = route.request().method()
    const json = (body: unknown) => route.fulfill({ json: body })

    if (pathname === '/api/me') {
      return json({ id: 1, login: 'tester', google_id: null, created_at: now, used_storage_bytes: 0 })
    }
    if (pathname === '/api/describe/jobs' && method === 'GET') return json([describeJob])
    if (pathname === '/api/describe/jobs/describe-1' && method === 'GET') return json(describeJob)
    if (pathname === '/api/describe/capabilities') {
      return json({
        capabilities: [{ base: 'llm.vision', raw: 'llm.vision[vision]', tags: ['vision'], online: true, last_available_at: now, usage_count: 0 }],
      })
    }
    if (pathname === '/api/describe/jobs' && method === 'POST') {
      submissions.push(route.request().postDataJSON())
      return json({ job_id: 'describe-2', status: 'submitted' })
    }
    if (pathname === '/api/describe/jobs/describe-2' && method === 'GET') return json({ ...describeJob, job_id: 'describe-2', status: 'submitted' })
    if (pathname === '/api/images/external-resize') return json({ available: false, threshold_bytes: 0 })
    if (pathname === '/api/progress/running') return json({ jobs: [] })
    if (pathname.startsWith('/api/prompts/')) return json({})
    return route.fulfill({ status: 404, json: { error: 'Not mocked' } })
  })

  await page.goto('/app/describe')
  await page.getByTestId('describe-item-describe-1').click()
  await page.getByTestId('describe-edit-prompt').click()

  await expect(page.getByTestId('describe-image-preview')).toBeVisible()
  await page.getByTestId('describe-submit').click()
  await expect.poll(() => submissions).toHaveLength(1)
  expect(submissions[0]).toEqual(expect.objectContaining({ image_id: 'image-42' }))
})
