import { expect, test, type Page } from '@playwright/test'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
async function mock(page: Page, options: { pending?: boolean; upscaleFail?: boolean; slowSubmit?: boolean; cancelTerminal?: boolean; cleanupFail?: boolean; hangPoll?: boolean; hangSubmit?: boolean } = {}) {
  const submissions: Record<string, unknown>[] = []
  const events: string[] = []
  let canceled = false
  let polls = 0
  await page.addInitScript(() => localStorage.setItem('oai_token', 'test-token'))
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname
    const method = route.request().method()
    if (!path.startsWith('/api/')) return route.continue()
    const json = (body: unknown) => route.fulfill({ json: body })
    if (path === '/api/me') return json({ id: 1, login: 'tester', used_storage_bytes: 0 })
    if (path === '/api/admin/am_i_admin') return json({ is_admin: false })
    if (path === '/api/progress/running') return json({ jobs: [] })
    if (path === '/api/images/capabilities') return json([{ base: 'imggen.test', tags: ['txt2img'], online: true }])
    if (path === '/api/img-utils/capabilities') return json({ capabilities: [{ base: 'img-utils.seedvr', utility: 'seedvr', workflows: ['upscale'], kind: 'comfy' }] })
    if (path === '/api/prompt-placeholders') return json([{ name: 'scene', variants: ['moon garden', 'glass forest'] }])
    if (path === '/api/prompts/imggen-prompt/entries') return json({ items: [{ id: '1', content: 'Imported dream', kind: 'recent' }], next_cursor: null })
    if (path.startsWith('/api/prompts/')) { events.push(path); return json({ id: 'p' }) }
    if (path === '/api/images/jobs' && method === 'POST') {
      canceled = false
      submissions.push(route.request().postDataJSON())
      events.push('generate')
      if (options.hangSubmit) return new Promise<void>(() => {})
      if (options.slowSubmit) await new Promise(resolve => setTimeout(resolve, 500))
      return json({ job_id: String(submissions.length), status: 'submitted' })
    }
    if (/\/images\/jobs\/\d+\/cancel$/.test(path)) {
      canceled = true; events.push('cancel')
      if (options.cancelTerminal) return route.fulfill({ status: 400, json: { error: 'job is already in terminal state: completed' } })
      return json({ status: 'canceled' })
    }
    if (/\/images\/jobs\/\d+\/poll$/.test(path)) {
      polls++
      if (options.hangPoll && polls === 1) { events.push('poll-hung'); return new Promise<void>(() => {}) }
      return json({ status: canceled ? options.cancelTerminal ? 'completed' : 'canceled' : options.pending ? 'running' : 'completed', output_images: [{ image_id: '10' }] })
    }
    if (path === '/api/img-utils/jobs' && method === 'POST') { events.push('upscale'); submissions.push(route.request().postDataJSON()); return json({ job_id: 'u', status: 'submitted' }) }
    if (path === '/api/img-utils/jobs/u/poll') return json({ status: options.upscaleFail ? 'failed' : 'completed', output_image_id: '20', error: options.upscaleFail ? 'Upscaler offline' : null })
    if (path.startsWith('/api/images/files/')) { events.push(`load:${path.split('/').pop()}`); return route.fulfill({ body: PNG, contentType: 'image/png' }) }
    if (method === 'DELETE') {
      events.push(`delete:${path}`)
      if (options.cleanupFail && path === '/api/img-utils/jobs/u') return route.fulfill({ status: 500, json: { error: 'Storage unavailable' } })
      return route.fulfill({ status: 204 })
    }
    return json({})
  })
  await page.goto('/app/hallucinate')
  await expect(page.getByRole('option', { name: 'test', exact: true })).toHaveCount(1)
  return { submissions, events }
}

test('renders sequentially, substitutes every frame, and removes temporary jobs', async ({ page }) => {
  const { submissions, events } = await mock(page)
  await page.getByTestId('hallucinate-prompt').fill('A {scene} under a {color} sky')
  await page.getByTestId('hallucinate-start').click()
  await expect(page.getByTestId('hallucinate-display').getByRole('img')).toHaveCount(1)
  await expect(page.getByTestId('hallucinate-display').getByRole('img').first()).toHaveCSS('object-fit', 'contain')
  await expect.poll(() => submissions.length, { timeout: 12000 }).toBe(2)
  expect(submissions[0].prompt).not.toContain('{')
  expect(submissions[0].prompt).not.toBe(submissions[1].prompt)
  expect(events.indexOf('delete:/api/images/jobs/1')).toBeLessThan(events.lastIndexOf('generate'))
  await page.getByTestId('hallucinate-pause').click()
  await expect(page.getByRole('button', { name: 'Resume wallpaper' })).toBeEnabled()
  const count = submissions.length
  await page.waitForTimeout(6500)
  expect(submissions).toHaveLength(count)
})

test('upscales ×2 before display and cleans both jobs', async ({ page }) => {
  const { submissions, events } = await mock(page)
  await page.getByLabel('Upscale before displaying').check()
  await page.getByTestId('hallucinate-start').click()
  await expect(page.getByTestId('hallucinate-display').getByRole('img')).toHaveCount(1)
  expect(submissions[1]).toMatchObject({ input_image_id: '10', workflow: 'upscale', options: { scale_multiplier: 2 } })
  expect(events).toContain('load:20')
  expect(events).not.toContain('load:10')
  await expect.poll(() => events.includes('delete:/api/img-utils/jobs/u')).toBe(true)
  await page.getByTestId('hallucinate-pause').click()
})

test('stopping during submission cancels the eventual task without scheduling another', async ({ page }) => {
  const { submissions, events } = await mock(page, { slowSubmit: true, pending: true })
  await page.getByTestId('hallucinate-start').click()
  await expect.poll(() => submissions.length).toBe(1)
  await page.getByTestId('hallucinate-pause').click()
  await expect.poll(() => events.includes('cancel')).toBe(true)
  await expect.poll(() => events.includes('delete:/api/images/jobs/1')).toBe(true)
  await expect(page.getByRole('button', { name: 'Resume wallpaper' })).toBeEnabled()
  expect(submissions).toHaveLength(1)
})

test('navigation cancels work', async ({ page }) => {
  const { events } = await mock(page, { pending: true })
  await page.getByTestId('hallucinate-start').click()
  await expect.poll(() => events.includes('generate')).toBe(true)
  await page.evaluate(() => { window.history.pushState({}, '', '/app/dashboard'); window.dispatchEvent(new PopStateEvent('popstate')) })
  await expect.poll(() => events.includes('cancel')).toBe(true)
})

test('upscale failure is visible and does not fall back or keep submitting', async ({ page }) => {
  const { submissions } = await mock(page, { upscaleFail: true })
  await page.getByLabel('Upscale before displaying').check()
  await page.getByTestId('hallucinate-start').click()
  await expect(page.getByRole('alert')).toHaveText('Upscaler offline')
  await expect(page.getByRole('button', { name: 'Resume wallpaper' })).toBeEnabled()
  expect(submissions).toHaveLength(2)
  await expect(page.getByTestId('hallucinate-display').getByRole('img')).toHaveCount(0)
})

for (const width of [320, 1280]) {
  test(`separate prompt import and canvas rows fit at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 })
    const { events } = await mock(page)
    await page.getByTestId('hallucinate-import').click()
    await page.getByText('Imported dream', { exact: true }).click()
    await expect(page.getByTestId('hallucinate-prompt')).toHaveValue('Imported dream')
    await expect.poll(() => events.includes('/api/prompts/hallucinate-prompt/recent')).toBe(true)
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1)
    await expect(page.getByRole('button', { name: '1920 × 1080' })).toBeVisible()
    await page.getByRole('button', { name: 'Star prompt', exact: true }).click()
    await expect.poll(() => events.includes('/api/prompts/hallucinate-prompt/star')).toBe(true)
  })
}


test('paused → settings → wallpaper remains resumable', async ({ page }) => {
  await mock(page)
  await page.getByTestId('hallucinate-start').click()
  await expect(page.getByTestId('hallucinate-display').getByRole('img').first()).toBeVisible()
  await page.getByRole('button', { name: 'Pause wallpaper' }).click()
  await expect(page.getByRole('button', { name: 'Resume wallpaper' })).toBeEnabled()
  await page.getByRole('button', { name: 'Wallpaper settings' }).click()
  await page.getByRole('button', { name: 'Return to wallpaper' }).click()
  await expect(page.getByRole('button', { name: 'Resume wallpaper' })).toBeEnabled()
  await expect(page.getByRole('status')).toHaveText('Paused')
})

test('Pause aborts a stalled poll and still cleans the task', async ({ page }) => {
  const { events } = await mock(page, { hangPoll: true, pending: true })
  await page.getByTestId('hallucinate-start').click()
  await expect.poll(() => events.includes('poll-hung')).toBe(true)
  await page.getByTestId('hallucinate-pause').click()
  await expect(page.getByRole('button', { name: 'Resume wallpaper' })).toBeEnabled()
  await expect.poll(() => events.includes('delete:/api/images/jobs/1')).toBe(true)
})

test('cancellation racing completion still deletes the terminal job', async ({ page }) => {
  const { events } = await mock(page, { pending: true, cancelTerminal: true })
  await page.getByTestId('hallucinate-start').click()
  await expect.poll(() => events.includes('generate')).toBe(true)
  await page.getByTestId('hallucinate-pause').click()
  await expect.poll(() => events.includes('delete:/api/images/jobs/1')).toBe(true)
  await expect(page.getByRole('button', { name: 'Resume wallpaper' })).toBeEnabled()
  await expect(page.getByRole('alert')).toHaveCount(0)
})

test('upscale cleanup failure does not skip generation cleanup or hide the error', async ({ page }) => {
  const { events } = await mock(page, { cleanupFail: true })
  await page.getByLabel('Upscale before displaying').check()
  await page.getByTestId('hallucinate-start').click()
  await expect(page.getByRole('alert')).toContainText('Temporary wallpaper cleanup failed')
  await expect.poll(() => events.includes('delete:/api/images/jobs/1')).toBe(true)
  await expect(page.getByRole('button', { name: 'Resume wallpaper' })).toBeEnabled()
})

test('controls fade after Resume even while its button retains focus', async ({ page }) => {
  await mock(page)
  await page.getByTestId('hallucinate-start').click()
  await page.getByRole('button', { name: 'Pause wallpaper' }).click()
  const resume = page.getByRole('button', { name: 'Resume wallpaper' })
  await expect(resume).toBeEnabled()
  await resume.click()
  await expect(page.getByRole('button', { name: 'Pause wallpaper' })).toBeFocused()
  await expect(page.getByTestId('hallucinate-controls')).toHaveCSS('opacity', '0', { timeout: 6500 })
  await page.mouse.move(10, 10)
  await expect(page.getByTestId('hallucinate-controls')).toHaveCSS('opacity', '1')
})

test('a stalled submission reaches its deadline instead of locking the page', async ({ page }) => {
  await mock(page, { hangSubmit: true })
  await page.getByTestId('hallucinate-start').click()
  await expect(page.getByRole('alert')).toContainText(/timeout|timed out/i, { timeout: 19000 })
  await expect(page.getByRole('button', { name: 'Resume wallpaper' })).toBeEnabled()
})


test('runtime status distinguishes queue time from execution and advances between polls', async ({ page }) => {
  const { events } = await mock(page)
  let status = 'queued'
  const estimated = 60
  const submittedAt = new Date(Date.now() - 30000).toISOString()
  const startedAt = new Date(Date.now() - 20000).toISOString()
  await page.route('**/api/images/jobs/*/poll', route => route.fulfill({ json: {
    status: events.includes('cancel') ? 'canceled' : status,
    stage: status === 'queued' ? 'Waiting for an agent' : 'Sampling',
    submitted_at: submittedAt,
    started_at: status === 'queued' ? null : startedAt,
    typical_runtime_seconds: estimated,
    output_images: [],
  } }))
  await page.getByTestId('hallucinate-start').click()
  const job = page.getByTestId('hallucinate-job-status')
  const progress = job.getByRole('progressbar')
  await expect(job).toContainText('Generation · Queued')
  await expect(job).toContainText('#1')
  await expect(progress).toHaveAttribute('data-progress-phase', 'indeterminate')
  await expect(page.getByTestId('hallucinate-job-timings')).toContainText('Render —')
  status = 'running'
  await expect(progress).toHaveAttribute('data-progress-phase', 'determinate')
  await expect(job).toContainText('Generation · Running')
  await expect(job).toContainText('Sampling')
  await expect(page.getByTestId('hallucinate-job-timings')).toContainText('Queue 10s')
  const before = Number(await progress.getAttribute('aria-valuenow'))
  expect(before).toBeGreaterThan(0)
  await expect.poll(async () => Number(await progress.getAttribute('aria-valuenow'))).toBeGreaterThan(before)
  await page.mouse.move(10, 10)
  await page.getByTestId('hallucinate-pause').click()
  await expect(page.getByRole('button', { name: 'Resume wallpaper' })).toBeEnabled()
  await expect(job).toContainText('Canceled')
  const frozen = await page.getByTestId('hallucinate-job-timings').textContent()
  await page.waitForTimeout(1100)
  expect(await page.getByTestId('hallucinate-job-timings').textContent()).toBe(frozen)
})

test('runtime upscale status and buttons hide together and return on mouse movement on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 844 })
  await mock(page)
  const createdAt = new Date(Date.now() - 20000).toISOString()
  const startedAt = new Date(Date.now() - 10000).toISOString()
  let canceled = false
  await page.route('**/api/img-utils/jobs/u/cancel', route => {
    canceled = true
    return route.fulfill({ json: { status: 'canceled' } })
  })
  await page.route('**/api/img-utils/jobs/u/poll', route => route.fulfill({ json: {
    job_id: 'u', status: canceled ? 'canceled' : 'running', stage: 'Enhancing detail',
    created_at: createdAt, started_at: startedAt, typical_runtime_seconds: null,
  } }))
  await page.getByLabel('Upscale before displaying').check()
  await page.getByTestId('hallucinate-start').click()
  const job = page.getByTestId('hallucinate-job-status')
  await expect(job).toContainText('Upscale · Running')
  await expect(job).toContainText('seedvr · #u')
  await expect(job).toContainText('Enhancing detail')
  await expect(job.getByRole('progressbar')).toHaveAttribute('data-progress-phase', 'indeterminate')
  await expect(job).toContainText('Queue 10s')
  await expect(job).not.toContainText('Render')
  await expect(page.getByTestId('hallucinate-controls')).toHaveCSS('opacity', '0', { timeout: 6500 })
  await expect(page.getByTestId('hallucinate-controls').getByTestId('hallucinate-job-status')).toHaveCount(1)
  await expect(page.getByTestId('hallucinate-controls')).toHaveCSS('pointer-events', 'none')
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1)
  await page.mouse.move(10, 10)
  await expect(page.getByTestId('hallucinate-controls')).toHaveCSS('opacity', '1')
  await expect(job.getByRole('progressbar')).toBeVisible()
  await page.getByTestId('hallucinate-pause').click()
  await expect(job).toContainText('Canceled')
  await expect(page.getByTestId('hallucinate-controls')).toHaveCSS('opacity', '1')
})
