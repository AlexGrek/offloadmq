import type { ImageCycleJob } from '../../frontend/src/api/imageCycles'
import { expect, test, type Page } from '@playwright/test'

const now = '2026-10-20T12:00:00Z'
const defaults = {
  initial_prompt: null, input_image_id: '42', describe_prompt: 'Describe this image',
  vision_model: 'llm.vision', image_model: 'imggen.paint', cycles: 2, width: 1024, height: 1024,
}
const step = (cycle: number, kind: 'describe' | 'generate', extra = {}) => ({
  cycle, kind, status: 'completed', prompt: 'Describe this image', input_image_id: null,
  output_image_id: null, result: null, child_job_id: '100', stage: null, error: null, ...extra,
})
const completed: ImageCycleJob = {
  job_id: '123', status: 'completed', params: defaults, error: null, created_at: now, updated_at: now,
  steps: [
    step(1, 'describe', { input_image_id: '42', result: 'A red fox at dawn.' }),
    step(1, 'generate', { prompt: 'A red fox at dawn.', output_image_id: '43' }),
    step(2, 'describe', { input_image_id: '43', result: 'A fox in golden morning mist.' }),
    step(2, 'generate', { prompt: 'A fox in golden morning mist.', output_image_id: '44' }),
  ],
}
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64')

async function setup(page: Page, initial: ImageCycleJob | null = null, improver = false) {
  const root = `/api/${improver ? 'generator-improver' : 'image-cycles'}/jobs`
  let job = initial
  const submissions: Record<string, unknown>[] = []
  const promptBuckets: string[] = []
  let polls = 0
  const controls: { path: string; body: unknown }[] = []
  await page.addInitScript(() => localStorage.setItem('oai_token', 'test-token'))
  await page.route('**/api/**', async route => {
    const { pathname } = new URL(route.request().url())
    if (!pathname.startsWith('/api/')) return route.continue()
    const method = route.request().method()
    const json = (body: unknown) => route.fulfill({ json: body })
    if (pathname === '/api/me') return json({ id: 1, login: 'tester', created_at: now, used_storage_bytes: 0 })
    if (pathname === '/api/progress/running') return json({ jobs: [] })
    if (pathname === '/api/describe/capabilities') return json({ capabilities: ['llm.vision', 'llm.vision-new'].map(base => ({ base, tags: ['vision'], raw: base+'[vision]', online: true })) })
    if (pathname === '/api/images/capabilities') return json([
      { base: 'imggen.paint', tags: ['txt2img'], raw: 'imggen.paint[txt2img]', online: true },
      { base: 'imggen.refine', tags: ['img2img'], raw: 'imggen.refine[img2img]', online: true },
      { base: 'imggen.paint-new', tags: ['txt2img'], raw: 'imggen.paint-new[txt2img]', online: true },
      { base: 'imggen.refine-new', tags: ['img2img'], raw: 'imggen.refine-new[img2img]', online: true },
      { base: 'imggen.video', tags: ['txt2video'], raw: 'imggen.video[txt2video]', online: true },
    ])
    if (pathname.endsWith('/starred')) return json({ starred: method === 'PATCH' ? route.request().postDataJSON().starred : false })
    if (pathname.startsWith('/api/images/files/') && method === 'DELETE') return route.fulfill({ status: 204 })
    if (pathname.startsWith('/api/images/files/')) return route.fulfill({ body: png, contentType: 'image/png' })
    if (pathname === '/api/images/upload') return json({ image_id: '42', filename: 'seed.png', content_type: 'image/png', width: 1, height: 1, size_bytes: png.length, rescaled: false, reencoded: false })
    if (pathname.startsWith('/api/prompts/')) {
      promptBuckets.push(pathname)
      return json({ items: [{ id: '1', bucket: 'describe-image-user', kind: 'starred', content: 'Write a cinematic image prompt.', created_at: now, updated_at: now, last_used_at: now }], next_cursor: null })
    }
    if (pathname === root && method === 'GET') return json(job ? [job] : [])
    if (pathname === root && method === 'POST') {
      const params = route.request().postDataJSON()
      submissions.push(params)
      job = { ...completed, status: 'running', params, steps: [step(1, 'describe', { status: 'submitted' })] }
      return json({ job_id: '123', status: 'submitted' })
    }
    if (job && ['/pause', '/resume', '/restart', '/models', '/vision-prompt'].some(suffix => pathname.endsWith(suffix))) {
      controls.push({ path: pathname, body: route.request().postData() ? route.request().postDataJSON() : null })
      if (pathname.endsWith('/pause')) job = { ...job, status: 'paused' }
      if (pathname.endsWith('/resume')) job = { ...job, status: 'running', error: null }
      if (pathname.endsWith('/models')) job = { ...job, params: { ...job.params, ...route.request().postDataJSON() } }
      if (pathname.endsWith('/vision-prompt')) {
        const prompt = route.request().postDataJSON().describe_prompt
        job = { ...job, params: { ...job.params, describe_prompt: prompt }, steps: job.steps.map(item =>
          item.kind === 'describe' && item.status === 'queued' && !item.child_job_id
            ? { ...item, prompt: prompt + (improver ? '\nReturn only a JSON object with quality and improve_prompt.' : '') }
            : item) }
      }
      if (pathname.endsWith('/restart')) {
        const checkpoint = pathname.match(/\/steps\/(\d+)\/restart$/)
        job = { ...job, job_id: '456', status: 'running', error: null, ...(checkpoint ? {
          steps: job.steps.map((item, index) => index < Number(checkpoint[1])
            ? { ...item, reused: true, child_job_id: null }
            : { ...item, reused: false, child_job_id: null, output_image_id: null, result: null, quality: null, improve_prompt: null, model: null, status: 'queued', stage: null, error: null }),
        } : {}) }
        return json({ job_id: '456', status: 'submitted' })
      }
      return json(job)
    }
    if (pathname.endsWith('/cancel') && job) { job = { ...job, status: 'canceled' }; return json(job) }
    if (pathname.endsWith('/poll') && job) { polls++; return json(job) }
    if (job && pathname === `${root}/${job.job_id}`) return json(job)
    return route.fulfill({ status: 404, json: { error: 'Not mocked' } })
  })
  return { submissions, promptBuckets, controls, polls: () => polls, finish: (next: ImageCycleJob = completed) => { job = next } }
}

test('text start sends chosen models, prompt, size and cycle count; shares Describe prompt library', async ({ page }) => {
  const state = await setup(page)
  await page.goto('/app/image-cycles')
  await expect(page.getByTestId('cycles-describe-prompt')).toHaveValue(/Describe this image in detail/)
  await page.getByTestId('cycles-mode-text').click()
  await page.getByTestId('cycles-initial-prompt').fill('A red fox')
  await page.getByTestId('cycles-count').fill('0')
  await expect(page.getByTestId('cycles-start')).toBeDisabled()
  await page.getByTestId('cycles-count').fill('2')
  await page.getByTestId('cycles-image-model-trigger').click()
  await expect(page.getByTestId('cycles-image-model-option-imggen.paint')).toBeVisible()
  await expect(page.getByTestId('cycles-image-model').getByText('video', { exact: true })).toHaveCount(0)
  await page.getByTestId('cycles-image-model-trigger').click()
  await page.getByTestId('cycles-describe-prompt').locator('..').getByTestId('prompt-list-open').click()
  await expect.poll(() => state.promptBuckets.some(p => p.includes('/describe-image-user/entries'))).toBe(true)
  await page.getByText('Write a cinematic image prompt.', { exact: true }).first().click()
  await expect(page.getByTestId('cycles-describe-prompt')).toHaveValue('Write a cinematic image prompt.')
  await page.getByTestId('cycles-start').click()
  await expect.poll(() => state.submissions.length).toBe(1)
  expect(state.submissions[0]).toEqual({ ...defaults, input_image_id: null, initial_prompt: 'A red fox', describe_prompt: 'Write a cinematic image prompt.' })
  await expect(page.getByTestId('cycles-detail')).toBeVisible()
  await expect(page).toHaveURL(/job=123/)
})

test('image start uploads one image and excludes any text draft', async ({ page }) => {
  const state = await setup(page)
  await page.goto('/app/image-cycles')
  await page.getByTestId('cycles-mode-text').click()
  await page.getByTestId('cycles-initial-prompt').fill('Unused draft')
  await page.getByTestId('cycles-mode-image').click()
  await page.getByTestId('cycles-upload').setInputFiles({ name: 'seed.png', mimeType: 'image/png', buffer: png })
  await expect(page.getByTestId('cycles-input-preview')).toBeVisible()
  await page.getByTestId('cycles-count').fill('1')
  await page.getByTestId('cycles-start').click()
  await expect.poll(() => state.submissions.length).toBe(1)
  expect(state.submissions[0]).toMatchObject({ input_image_id: '42', initial_prompt: null, cycles: 1 })
  await page.getByTestId('cycles-cancel').click()
  await expect(page.getByTestId('cycles-status')).toContainText('canceled')
})

test('all intermediate descriptions, generation prompts and images survive reload on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 })
  const state = await setup(page, completed)
  await page.goto('/app/image-cycles?job=123')
  await expect(page.getByTestId('cycles-step-result-0')).toContainText('A red fox at dawn.')
  await expect(page.getByTestId('cycles-step-prompt-1')).toHaveText('A red fox at dawn.')
  await expect(page.getByTestId('cycles-step-result-2')).toContainText('A fox in golden morning mist.')
  await expect(page.getByTestId('cycles-step-prompt-3')).toHaveText('A fox in golden morning mist.')
  await expect(page.getByTestId('cycles-step-image-1')).toBeVisible()
  await expect(page.getByTestId('cycles-step-image-3')).toBeVisible()
  await page.reload()
  await expect(page.getByTestId('cycles-step-image-3')).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.waitForTimeout(3300)
  expect(state.polls()).toBe(0)
})

test('live run reveals completed steps and stops automatic polling at completion', async ({ page }) => {
  const state = await setup(page, { ...completed, status: 'running', steps: completed.steps.slice(0, 1) })
  await page.goto('/app/image-cycles?job=123')
  await expect(page.getByTestId('cycles-status')).toContainText('running')
  state.finish()
  await expect(page.getByTestId('cycles-step-image-3')).toBeVisible({ timeout: 8000 })
  await expect(page.getByTestId('cycles-status')).toContainText('completed')
  const polls = state.polls()
  await page.waitForTimeout(3300)
  expect(state.polls()).toBe(polls)
})


test('Generator Improver selects img2img and submits expected quality and a step limit', async ({ page }) => {
  const state = await setup(page, null, true)
  await page.goto('/app/generator-improver')
  await expect(page.getByRole('heading', { name: 'Generator Improver', exact: true })).toBeVisible()
  await page.getByTestId('cycles-upload').setInputFiles({ name: 'seed.png', mimeType: 'image/png', buffer: png })
  await page.getByTestId('improver-quality').fill('101')
  await expect(page.getByTestId('cycles-start')).toBeDisabled()
  await page.getByTestId('improver-quality').fill('97')
  await page.getByTestId('cycles-count').fill('4')
  await page.getByTestId('cycles-image-model-trigger').click()
  await expect(page.getByTestId('cycles-image-model-option-imggen.refine')).toBeVisible()
  await expect(page.getByTestId('cycles-image-model-option-imggen.paint')).toHaveCount(0)
  await page.getByTestId('cycles-image-model-trigger').click()
  await page.getByTestId('cycles-start').click()
  await expect.poll(() => state.submissions.length).toBe(1)
  expect(state.submissions[0]).toMatchObject({ image_model: 'imggen.refine', expected_quality: 97, max_steps: 4, input_image_id: '42', initial_prompt: null })
})

test('Generator Improver text starts use a separate txt2img model', async ({ page }) => {
  const state = await setup(page, null, true)
  await page.goto('/app/generator-improver')
  await page.getByTestId('cycles-mode-text').click()
  await page.getByTestId('cycles-initial-prompt').fill('A fox in a forest')
  await expect(page.getByTestId('improver-bootstrap-model-trigger')).toContainText('paint')
  await page.getByTestId('cycles-start').click()
  await expect.poll(() => state.submissions.length).toBe(1)
  expect(state.submissions[0]).toMatchObject({ image_model: 'imggen.refine', bootstrap_model: 'imggen.paint', initial_prompt: 'A fox in a forest', input_image_id: null })
})

test('Generator Improver can use txt2img throughout a text-only run and keeps its model editor workflow', async ({ page }) => {
  const state = await setup(page, null, true)
  await page.goto('/app/generator-improver')
  await page.getByTestId('cycles-mode-text').click()
  await page.getByTestId('cycles-initial-prompt').fill('A fox in a forest')
  await page.getByTestId('improver-workflow-txt2img').click()
  await expect(page.getByTestId('cycles-image-model-trigger')).toContainText('paint')
  await page.getByTestId('cycles-image-model-trigger').click()
  await expect(page.getByTestId('cycles-image-model-option-imggen.paint')).toBeVisible()
  await expect(page.getByTestId('cycles-image-model-option-imggen.refine')).toHaveCount(0)
  await page.getByTestId('cycles-image-model-trigger').click()
  await page.getByTestId('improver-workflow-txt2img').click() // Clicking the selected mode keeps the form usable.
  await expect(page.getByTestId('cycles-start')).toBeEnabled()
  await page.getByTestId('cycles-start').click()
  await expect.poll(() => state.submissions.length).toBe(1)
  expect(state.submissions[0]).toMatchObject({ improvement_workflow: 'txt2img', image_model: 'imggen.paint', initial_prompt: 'A fox in a forest', input_image_id: null })
  await expect(page).toHaveURL(/job=123/)
  await expect(page.getByTestId('cycles-detail')).toBeVisible()
  await page.reload() // The form defaults to img2img; this run's editor must still list txt2img models.
  await page.getByTestId('cycles-change-models').click()
  await page.getByTestId('cycles-edit-image-model-trigger').click()
  await expect(page.getByTestId('cycles-edit-image-model-option-imggen.refine')).toHaveCount(0)
  await page.getByTestId('cycles-edit-image-model-option-imggen.paint-new').click()
  await page.getByTestId('cycles-save-models').click()
  expect(state.controls.find(c => c.path.endsWith('/models'))?.body).toMatchObject({ image_model: 'imggen.paint-new' })
})

for (const reason of ['target_reached', 'max_steps_reached'] as const) {
  test(`Generator Improver shows quality history, JSON, prompts and ${reason}`, async ({ page }) => {
    const lastQuality = reason === 'target_reached' ? 96 : 90
    const run: ImageCycleJob = { ...completed, app: 'generator-improver', stop_reason: reason,
      params: { ...defaults, image_model: 'imggen.refine', expected_quality: 95, max_steps: 2 },
      steps: [
        step(1, 'describe', { quality: 60, improve_prompt: 'Fix the lighting.', result: '{"quality":60,"improve_prompt":"Fix the lighting."}' }),
        step(1, 'generate', { prompt: 'Fix the lighting.', input_image_id: '42', output_image_id: '43' }),
        step(2, 'describe', { quality: lastQuality, improve_prompt: 'Sharpen the fur.', result: JSON.stringify({ quality: lastQuality, improve_prompt: 'Sharpen the fur.' }) }),
      ] }
    await setup(page, run, true)
    await page.setViewportSize({ width: 375, height: 800 })
    await page.goto('/app/generator-improver?job=123')
    await expect(page.getByTestId('improver-quality-chart')).toHaveAccessibleName('Quality by assessment, out of 100')
    await expect(page.getByTestId('improver-quality-point-1')).toContainText('60')
    await expect(page.getByTestId('improver-quality-point-2')).toContainText(String(lastQuality))
    await expect(page.getByTestId('improver-quality-summary')).toContainText(`Latest: ${lastQuality}/100 · +${lastQuality - 60} points from start`)
    await expect(page.getByTestId('improver-quality-target')).toHaveAttribute('stroke-dasharray', '6 4')
    await expect(page.getByTestId('improver-quality-0')).toHaveText('Quality: 60/100')
    await expect(page.getByTestId('improver-prompt-0')).toHaveText('Fix the lighting.')
    await expect(page.getByTestId('cycles-step-prompt-1')).toHaveText('Fix the lighting.')
    await expect(page.getByTestId('cycles-step-result-0')).toContainText('"quality":60')
    await expect(page.getByTestId('cycles-step-image-1')).toBeVisible()
    await expect(page.getByTestId('improver-stop-reason')).toContainText(reason === 'target_reached' ? 'Expected quality reached' : 'Maximum improvements reached')
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.screenshot({ path: `/tmp/generator-improver-${reason}.png` })
  })
}

test('Generator Improver graph updates from no score through zero and declining scores', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 })
  const run: ImageCycleJob = { ...completed, app: 'generator-improver', status: 'running',
    params: { ...defaults, expected_quality: 95, max_steps: 2 },
    steps: [step(1, 'describe', { status: 'submitted' })] }
  const state = await setup(page, run, true)
  await page.goto('/app/generator-improver?job=123')
  await expect(page.getByTestId('improver-quality-graph')).toContainText('Waiting for the first assessment')
  await expect(page.getByTestId('improver-quality-chart')).toHaveCount(0)
  state.finish({ ...run, steps: [step(1, 'describe', { quality: 60 })] })
  await expect(page.getByTestId('improver-quality-point-1')).toBeVisible({ timeout: 8000 })
  await expect(page.getByTestId('improver-quality-summary')).toHaveText('Latest: 60/100')
  state.finish({ ...run, status: 'completed', steps: [
    step(1, 'describe', { quality: 60 }),
    step(1, 'generate', { quality: 99 }), // Only vision assessments belong in the graph.
    step(2, 'describe', { quality: 0 }),
    step(3, 'describe', { status: 'skipped' }),
  ] })
  await expect(page.getByTestId('improver-quality-summary')).toHaveText('Latest: 0/100 · -60 points from start', { timeout: 8000 })
  await expect(page.getByTestId('improver-quality-chart').locator('circle')).toHaveCount(2)
  await page.evaluate(() => localStorage.setItem('oai_theme', 'dark'))
  await page.reload()
  await expect(page.getByTestId('improver-quality-point-2')).toContainText('0')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.getByTestId('improver-quality-graph').screenshot({ path: '/tmp/generator-improver-quality-dark.png' })
  state.finish({ ...run, status: 'completed', steps: Array.from({ length: 51 }, (_, index) =>
    step(index + 1, 'describe', { quality: index * 2 })) })
  await page.reload()
  await expect(page.getByTestId('improver-quality-chart').locator('circle')).toHaveCount(51)
  const graphViewport = page.getByTestId('improver-quality-chart').locator('..')
  expect(await graphViewport.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.evaluate(() => localStorage.setItem('oai_theme', 'light'))
  await page.setViewportSize({ width: 1280, height: 900 })
  state.finish({ ...run, status: 'completed', steps: [step(1, 'describe', { quality: 60 }), step(2, 'describe', { quality: 95 })] })
  await page.reload()
  await expect(page.getByTestId('improver-quality-summary')).toContainText('Latest: 95/100')
  await page.getByTestId('improver-quality-graph').screenshot({ path: '/tmp/generator-improver-quality-light.png' })
})


for (const improver of [false, true]) {
  test(`${improver ? 'Generator Improver' : 'Image Cycles'} can pause, edit models, resume, cancel and restart`, async ({ page }) => {
    const app = improver ? 'generator-improver' : 'image-cycles'
    const params = { ...defaults, ...(improver ? { initial_prompt: 'A fox', input_image_id: null, expected_quality: 95, max_steps: 2, image_model: 'imggen.refine', bootstrap_model: 'imggen.paint' } : {}) }
    const state = await setup(page, { ...completed, app, params, status: 'running', steps: [step(1, 'describe', { status: 'submitted', model: 'llm.vision' })] }, improver)
    await page.goto(`/app/${app}?job=123`)
    await page.getByTestId('cycles-pause').click()
    await expect(page.getByTestId('cycles-status')).toContainText('paused')
    await page.reload()
    await expect(page.getByTestId('cycles-pause-note')).toBeVisible()
    await page.getByTestId('cycles-change-models').click()
    await page.getByTestId('cycles-edit-vision-model-trigger').click()
    await page.getByTestId('cycles-edit-vision-model-option-llm.vision-new').click()
    await page.getByTestId('cycles-edit-image-model-trigger').click()
    await page.getByTestId(`cycles-edit-image-model-option-imggen.${improver ? 'refine-new' : 'paint-new'}`).click()
    if (improver) {
      await page.getByTestId('cycles-edit-bootstrap-model-trigger').click()
      await page.getByTestId('cycles-edit-bootstrap-model-option-imggen.paint-new').click()
    }
    await page.getByTestId('cycles-save-models').click()
    await expect(page.getByTestId('cycles-model-editor')).not.toBeVisible()
    const change = state.controls.find(c => c.path.endsWith('/models'))
    expect(change?.body).toMatchObject({ vision_model: 'llm.vision-new', image_model: `imggen.${improver ? 'refine-new' : 'paint-new'}`, ...(improver ? { bootstrap_model: 'imggen.paint-new' } : {}) })
    await expect(page.getByTestId('cycles-step-model-0')).toHaveText('Model: llm.vision')
    await expect(page.getByTestId('cycles-status')).toContainText('paused')
    await page.getByTestId('cycles-resume').click()
    await expect(page.getByTestId('cycles-status')).toContainText('running')
    await page.getByTestId('cycles-cancel').click()
    await expect(page.getByTestId('cycles-status')).toContainText('canceled')
    await page.getByTestId('cycles-restart').click()
    await expect(page).toHaveURL(/job=456/)
    await expect(page.getByTestId('cycles-status')).toContainText('running')
  })
}

test('a failed fenced assessment exposes its raw source and can retry parsing', async ({ page }) => {
  const raw = '```json\n{"quality":85,"improve_prompt":"Fix lighting"}\n```'
  const state = await setup(page, { ...completed, app: 'generator-improver', status: 'failed', error: 'expected value at line 1 column 1', steps: [step(1, 'describe', { status: 'failed', result: raw, error: 'parse failed' })] }, true)
  await page.goto('/app/generator-improver?job=123')
  await page.getByText('Raw vision response', { exact: true }).click()
  await expect(page.getByTestId('improver-raw-0')).toHaveText(raw)
  await page.getByTestId('cycles-retry-parsing').click()
  await expect(page.getByTestId('cycles-status')).toContainText('running')
  expect(state.controls.some(c => c.path.endsWith('/resume'))).toBe(true)
  expect(state.submissions).toHaveLength(0)
})

for (const improver of [false, true]) {
  test(`${improver ? 'Generator Improver' : 'Image Cycles'} edits the live vision prompt without overwriting history or drafts during polling`, async ({ page }) => {
    if (improver) await page.setViewportSize({ width: 390, height: 844 })
    const running: ImageCycleJob = {
      ...completed, app: improver ? 'generator-improver' : 'image-cycles', status: 'running',
      steps: [
        step(1, 'describe', { status: 'submitted', prompt: 'Original active vision prompt' }),
        step(1, 'generate', { status: 'queued', child_job_id: null }),
        step(2, 'describe', { status: 'queued', child_job_id: null }),
        step(2, 'generate', { status: 'queued', child_job_id: null }),
      ],
    }
    const state = await setup(page, running, improver)
    await page.goto(`/app/${improver ? 'generator-improver' : 'image-cycles'}?job=123`)
    await page.getByTestId('cycles-edit-vision-prompt').click()
    const draft = page.getByTestId('cycles-run-vision-prompt')
    await expect(draft).toHaveValue(defaults.describe_prompt)
    await draft.fill('  ')
    await expect(page.getByTestId('cycles-save-vision-prompt')).toBeDisabled()
    await draft.fill('Draft that survives polling')
    await page.getByTestId('cycles-poll').click()
    await expect.poll(() => state.polls()).toBeGreaterThan(0)
    await expect(draft).toHaveValue('Draft that survives polling')
    await draft.locator('..').getByTestId('prompt-list-open').click()
    await page.getByText('Write a cinematic image prompt.', { exact: true }).first().click()
    await expect(draft).toHaveValue('Write a cinematic image prompt.')
    await page.getByTestId('cycles-save-vision-prompt').click()
    await expect(page.getByTestId('cycles-vision-prompt-editor')).not.toBeVisible()
    expect(state.controls.at(-1)).toMatchObject({ path: expect.stringContaining('/123/vision-prompt'), body: { describe_prompt: 'Write a cinematic image prompt.' } })
    await expect(page.getByTestId('cycles-step-prompt-0')).toHaveText('Original active vision prompt')
    await expect(page.getByTestId('cycles-step-prompt-2')).toContainText('Write a cinematic image prompt.')
    await page.reload()
    await page.getByTestId('cycles-edit-vision-prompt').click()
    await expect(draft).toHaveValue('Write a cinematic image prompt.')
    await draft.fill('Discard this edit')
    await page.getByRole('button', { name: 'Discard prompt changes' }).click()
    await page.getByTestId('cycles-edit-vision-prompt').click()
    await expect(draft).toHaveValue('Write a cinematic image prompt.')
    expect(state.submissions).toHaveLength(0)
  })

  test(`${improver ? 'Generator Improver' : 'Image Cycles'} restarts from a selected step and reuses its completed predecessors`, async ({ page }) => {
    const active: ImageCycleJob = {
      ...completed, status: 'running', steps: completed.steps.map((item, index) => ({
        ...item, status: index === 0 ? 'submitted' : 'queued', output_image_id: null, result: null,
      })),
    }
    const state = await setup(page, active, improver)
    await page.goto(`/app/${improver ? 'generator-improver' : 'image-cycles'}?job=123`)
    await expect(page.getByTestId('cycles-restart-step-0')).toBeEnabled()
    for (let index = 1; index < active.steps.length; index++) {
      await expect(page.getByTestId(`cycles-restart-step-${index}`)).toBeDisabled()
    }
    state.finish(completed)
    await page.getByTestId('cycles-poll').click()
    for (let index = 0; index < completed.steps.length; index++) {
      await expect(page.getByTestId(`cycles-restart-step-${index}`)).toBeEnabled()
    }
    await page.getByTestId('cycles-restart-step-1').click()
    await expect(page).toHaveURL(/job=456/)
    expect(state.controls.at(-1)?.path).toMatch(/\/123\/steps\/1\/restart$/)
    await expect(page.getByTestId('cycles-step-0')).toContainText('Reused result')
    await expect(page.getByTestId('cycles-step-result-0')).toContainText('A red fox at dawn.')
    await expect(page.getByTestId('cycles-step-1')).toContainText('queued')
    await expect(page.getByTestId('cycles-step-image-1')).toHaveCount(0)
    await expect(page.getByTestId('cycles-step-prompt-1')).toHaveText('A red fox at dawn.')
    expect(state.submissions).toHaveLength(0)
  })

  for (const textStart of [false, true]) {
    test(`${improver ? 'Generator Improver' : 'Image Cycles'} compares the ${textStart ? 'first generated' : 'input'} image with the latest live result`, async ({ page }) => {
      if (improver) await page.setViewportSize({ width: 390, height: 844 })
      const firstId = textStart ? '41' : '42'
      const run: ImageCycleJob = textStart ? {
        ...completed,
        params: { ...defaults, input_image_id: null, initial_prompt: 'A fox' },
        steps: [step(0, 'generate', { output_image_id: firstId }), ...completed.steps],
      } : completed
      const state = await setup(page, {
        ...run, status: 'running', steps: textStart ? run.steps.slice(0, 1) : [],
      }, improver)
      await page.goto(`/app/${improver ? 'generator-improver' : 'image-cycles'}?job=123`)
      await expect(page.getByTestId('cycles-detail')).toBeVisible()
      await expect(page.getByTestId('cycles-compare-toggle')).toHaveCount(0)

      state.finish({ ...run, status: 'running', steps: run.steps.slice(0, textStart ? 3 : 2) })
      const toggle = page.getByTestId('cycles-compare-toggle')
      await expect(toggle).toBeVisible({ timeout: 8000 })
      await toggle.click()
      const before = page.getByTestId('cycles-compare-before')
      const latest = page.getByTestId('cycles-compare-latest')
      await expect(before.locator('img')).toHaveAttribute('src', new RegExp(`/${firstId}\\?token=`))
      await expect(latest.locator('img')).toHaveAttribute('src', /\/43\?token=/)

      state.finish(run)
      await expect(latest.locator('img')).toHaveAttribute('src', /\/44\?token=/, { timeout: 8000 })
      await expect(before.locator('img')).toHaveAttribute('src', new RegExp(`/${firstId}\\?token=`))
      await latest.click()
      await expect(page.getByTestId('image-lightbox-image')).toHaveAttribute('src', /\/44\?token=/)
      await page.keyboard.press('Escape')
      await before.click()
      await expect(page.getByTestId('image-lightbox-image')).toHaveAttribute('src', new RegExp(`/${firstId}\\?token=`))
      await page.keyboard.press('Escape')
      await expect(page.getByTestId('cycles-timeline')).toBeVisible()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
      await toggle.click()
      await expect(page.getByTestId('cycles-compare-view')).not.toBeVisible()
      await toggle.click()
      if (improver) await page.getByRole('button', { name: 'Toggle run history' }).click()
      await page.getByTestId('cycles-new').click()
      await expect(page.getByTestId('cycles-form')).toBeVisible()
      if (improver) await page.getByRole('button', { name: 'Toggle run history' }).click()
      await page.getByTestId('cycles-item-123').click()
      await expect(toggle).toHaveAttribute('aria-pressed', 'false')
    })
  }

  for (const sourceImprover of [false, true]) {
    test(`lightbox sends the selected image from ${sourceImprover ? 'improver' : 'cycles'} to a new ${improver ? 'improver' : 'cycles'} run`, async ({ page }) => {
      if (sourceImprover) await page.setViewportSize({ width: 390, height: 844 })
      const state = await setup(page, completed, improver)
      const sourceApp = sourceImprover ? 'generator-improver' : 'image-cycles'
      const targetApp = improver ? 'generator-improver' : 'image-cycles'
      if (sourceImprover !== improver) {
        await page.route(`**/api/${sourceApp}/jobs**`, route => route.fulfill({
          json: new URL(route.request().url()).pathname.endsWith('/jobs') ? [completed] : completed,
        }))
      }
      await page.goto(`/app/${sourceApp}?job=123`)
      await page.getByTestId('cycles-step-image-3').click()
      await page.getByTestId('image-lightbox-etc').click()
      await expect(page.getByRole('menuitem', { name: 'Send to improver', exact: true })).toBeVisible()
      await expect(page.getByRole('menuitem', { name: 'Send to cycles', exact: true })).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(page.getByRole('menu')).not.toBeVisible()
      await expect(page.getByTestId('image-lightbox')).toBeVisible()
      await page.getByTestId('image-lightbox-etc').click()
      await page.getByRole('menuitem', { name: improver ? 'Send to improver' : 'Send to cycles', exact: true }).click()
      await expect(page).toHaveURL(`/app/${targetApp}`)
      await expect(page.getByTestId('image-lightbox')).not.toBeVisible()
      await expect(page.getByTestId('cycles-form')).toBeVisible()
      await expect(page.getByTestId('cycles-input-preview')).toHaveAttribute('src', /\/44\?token=/)
      await expect(page.getByTestId('cycles-mode-image')).toHaveAttribute('aria-pressed', 'true')
      expect(state.submissions).toHaveLength(0)
      await page.getByTestId('cycles-start').click()
      await expect.poll(() => state.submissions.length).toBe(1)
      expect(state.submissions[0]).toMatchObject({ input_image_id: '44', initial_prompt: null })
    })
  }

  test(`${improver ? 'Generator Improver' : 'Image Cycles'} history previews the input or first generated image as results arrive`, async ({ page }) => {
    if (improver) {
      await page.setViewportSize({ width: 390, height: 844 })
      await page.addInitScript(() => localStorage.setItem('oai_theme', 'dark'))
    }
    const state = await setup(page, completed, improver)
    const url = `/app/${improver ? 'generator-improver' : 'image-cycles'}?job=123`
    const preview = page.getByTestId('cycles-item-preview-123')
    const showHistory = async () => {
      if (improver) await page.getByRole('button', { name: 'Toggle run history' }).click()
    }
    await page.goto(url)
    await showHistory()
    await expect(preview).toBeVisible()
    await expect(preview).toHaveAttribute('src', /\/42\/thumbnail\?token=/)
    await expect.poll(() => preview.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0)

    const textRun: ImageCycleJob = {
      ...completed,
      params: { ...defaults, input_image_id: null, initial_prompt: 'A fox' },
      steps: [step(0, 'generate', { output_image_id: '43' }), ...completed.steps],
    }
    state.finish(textRun)
    await page.reload()
    await showHistory()
    await expect(preview).toHaveAttribute('src', /\/43\/thumbnail\?token=/)

    state.finish({ ...textRun, status: 'running', steps: [step(0, 'generate', { status: 'submitted' })] })
    await page.reload()
    await showHistory()
    await expect(page.getByTestId('cycles-item-123')).toContainText('running')
    await expect(preview).toHaveCount(0)
    state.finish(textRun)
    await expect(preview).toBeVisible({ timeout: 8000 })
    await expect(preview).toHaveAttribute('src', /\/43\/thumbnail\?token=/)
    await page.getByTestId('cycles-item-123').click()
    await expect(page.getByTestId('cycles-detail')).toBeVisible()
  })

  test(`${improver ? 'Generator Improver' : 'Image Cycles'} opens step images in the standard lightbox and browses the run`, async ({ page }) => {
    await setup(page, { ...completed, app: improver ? 'generator-improver' : 'image-cycles' }, improver)
    await page.goto(`/app/${improver ? 'generator-improver' : 'image-cycles'}?job=123`)
    await page.getByTestId('cycles-step-image-1').click()
    await expect(page.getByTestId('image-lightbox')).toBeVisible()
    await expect(page.getByTestId('image-lightbox-image')).toHaveAttribute('src', /\/43\?token=/)
    await expect(page.getByTestId('image-lightbox-counter')).toHaveText('2 / 3')
    await expect(page.getByTestId('image-lightbox-download')).toBeVisible()
    await expect(page.getByTestId('image-lightbox-describe')).toBeVisible()
    await page.getByTestId('image-lightbox-star').click()
    await expect(page.getByTestId('image-lightbox-star')).toHaveAttribute('aria-pressed', 'true')
    await page.getByTestId('image-lightbox-prompt-toggle').click()
    await expect(page.getByTestId('image-lightbox-prompt')).toContainText('A red fox at dawn.')
    await page.keyboard.press('ArrowRight')
    await expect(page.getByTestId('image-lightbox-counter')).toHaveText('3 / 3')
    await expect(page.getByTestId('image-lightbox-image')).toHaveAttribute('src', /\/44\?token=/)
    await expect(page.getByTestId('image-lightbox-prompt')).toContainText('A fox in golden morning mist.')
    await page.keyboard.press('ArrowLeft')
    await expect(page.getByTestId('image-lightbox-counter')).toHaveText('2 / 3')
    await page.keyboard.press('ArrowLeft')
    await expect(page.getByTestId('image-lightbox-counter')).toHaveText('1 / 3')
    await expect(page.getByTestId('image-lightbox-image')).toHaveAttribute('src', /\/42\?token=/)
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('image-lightbox')).not.toBeVisible()
    await expect(page.getByTestId('cycles-detail')).toBeVisible()
    await page.getByTestId('cycles-step-image-3').click()
    await expect(page.getByTestId('image-lightbox-counter')).toHaveText('3 / 3')
  })
}
