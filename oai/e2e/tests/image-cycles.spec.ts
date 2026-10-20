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
  await page.addInitScript(() => localStorage.setItem('oai_token', 'test-token'))
  await page.route('**/api/**', async route => {
    const { pathname } = new URL(route.request().url())
    if (!pathname.startsWith('/api/')) return route.continue()
    const method = route.request().method()
    const json = (body: unknown) => route.fulfill({ json: body })
    if (pathname === '/api/me') return json({ id: 1, login: 'tester', created_at: now, used_storage_bytes: 0 })
    if (pathname === '/api/progress/running') return json({ jobs: [] })
    if (pathname === '/api/describe/capabilities') return json({ capabilities: [{ base: 'llm.vision', tags: ['vision'], raw: 'llm.vision[vision]', online: true }] })
    if (pathname === '/api/images/capabilities') return json([
      { base: 'imggen.paint', tags: ['txt2img'], raw: 'imggen.paint[txt2img]', online: true },
      { base: 'imggen.refine', tags: ['img2img'], raw: 'imggen.refine[img2img]', online: true },
      { base: 'imggen.video', tags: ['txt2video'], raw: 'imggen.video[txt2video]', online: true },
    ])
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
    if (pathname.endsWith('/cancel') && job) { job = { ...job, status: 'canceled' }; return json(job) }
    if (pathname.endsWith('/poll') && job) { polls++; return json(job) }
    if (pathname === `${root}/123` && job) return json(job)
    return route.fulfill({ status: 404, json: { error: 'Not mocked' } })
  })
  return { submissions, promptBuckets, polls: () => polls, finish: (next: ImageCycleJob = completed) => { job = next } }
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
