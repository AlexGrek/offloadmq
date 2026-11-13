import { expect, test, type Page } from '@playwright/test'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
async function mock(page: Page, options: { isAdmin?: boolean; pending?: boolean; upscaleFail?: boolean; slowSubmit?: boolean; cancelTerminal?: boolean; hangPoll?: boolean; hangSubmit?: boolean } = {}) {
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
    if (path === '/api/admin/am_i_admin') return json({ is_admin: options.isAdmin ?? false })
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
      return route.fulfill({ status: 204 })
    }
    return json({})
  })
  await page.goto('/app/hallucinate')
  await expect(page.getByRole('option', { name: 'test', exact: true })).toHaveCount(1)
  return { submissions, events }
}

test('renders sequentially, substitutes every frame, and preserves generated history', async ({ page }) => {
  const { submissions, events } = await mock(page)
  await page.getByTestId('hallucinate-prompt').fill('A {scene} under a {color} sky')
  await page.getByTestId('hallucinate-start').click()
  await expect(page.getByTestId('hallucinate-display').getByRole('img')).toHaveCount(1)
  await expect(page.getByTestId('hallucinate-display').getByRole('img').first()).toHaveCSS('object-fit', 'contain')
  await expect.poll(() => submissions.length, { timeout: 12000 }).toBe(2)
  expect(submissions[0].prompt).not.toContain('{')
  expect(submissions[0].prompt).not.toBe(submissions[1].prompt)
  expect(events.some(event => event.startsWith('delete:'))).toBe(false)
  await page.getByTestId('hallucinate-pause').click()
  await expect(page.getByRole('button', { name: 'Resume wallpaper' })).toBeEnabled()
  const count = submissions.length
  await page.waitForTimeout(6500)
  expect(submissions).toHaveLength(count)
  expect(events.some(event => event.startsWith('delete:'))).toBe(false)
})

test('upscales ×2 before display and preserves both histories', async ({ page }) => {
  const { submissions, events } = await mock(page)
  await page.getByLabel('Upscale before displaying').check()
  await page.getByTestId('hallucinate-start').click()
  await expect(page.getByTestId('hallucinate-display').getByRole('img')).toHaveCount(1)
  expect(submissions[1]).toMatchObject({ input_image_id: '10', workflow: 'upscale', options: { scale_multiplier: 2 } })
  expect(events).toContain('load:20')
  expect(events).not.toContain('load:10')
  await page.getByTestId('hallucinate-pause').click()
  await expect(page.getByRole('button', { name: 'Resume wallpaper' })).toBeEnabled()
  expect(events.some(event => event.startsWith('delete:'))).toBe(false)
})

test('stopping during submission cancels the eventual task without scheduling another', async ({ page }) => {
  const { submissions, events } = await mock(page, { slowSubmit: true, pending: true })
  await page.getByTestId('hallucinate-start').click()
  await expect.poll(() => submissions.length).toBe(1)
  await page.getByTestId('hallucinate-pause').click()
  await expect.poll(() => events.includes('cancel')).toBe(true)
  await expect(page.getByRole('button', { name: 'Resume wallpaper' })).toBeEnabled()
  expect(submissions).toHaveLength(1)
  expect(events.some(event => event.startsWith('delete:'))).toBe(false)
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

test('Pause aborts a stalled poll and cancels without deleting history', async ({ page }) => {
  const { events } = await mock(page, { hangPoll: true, pending: true })
  await page.getByTestId('hallucinate-start').click()
  await expect.poll(() => events.includes('poll-hung')).toBe(true)
  await page.getByTestId('hallucinate-pause').click()
  await expect(page.getByRole('button', { name: 'Resume wallpaper' })).toBeEnabled()
  expect(events).toContain('cancel')
  expect(events.some(event => event.startsWith('delete:'))).toBe(false)
})

test('cancellation racing completion preserves the completed job', async ({ page }) => {
  const { events } = await mock(page, { pending: true, cancelTerminal: true })
  await page.getByTestId('hallucinate-start').click()
  await expect.poll(() => events.includes('generate')).toBe(true)
  await page.getByTestId('hallucinate-pause').click()
  await expect(page.getByRole('button', { name: 'Resume wallpaper' })).toBeEnabled()
  await expect(page.getByRole('alert')).toHaveCount(0)
  expect(events.some(event => event.startsWith('delete:'))).toBe(false)
})

test('upscale cancellation failure is visible and preserves the generated input', async ({ page }) => {
  const { events, submissions } = await mock(page)
  let cancelAttempted = false
  await page.route('**/api/img-utils/jobs/u/cancel', route => {
    cancelAttempted = true
    return route.fulfill({ status: 500, json: { error: 'Agent unreachable' } })
  })
  await page.route('**/api/img-utils/jobs/u/poll', route => cancelAttempted
    ? route.fulfill({ status: 500, json: { error: 'Agent unreachable' } })
    : route.fulfill({ json: { job_id: 'u', status: 'running', stage: 'Upscaling' } }))
  await page.getByLabel('Upscale before displaying').check()
  await page.getByTestId('hallucinate-start').click()
  await expect(page.getByTestId('hallucinate-job-status')).toContainText('Upscale · Running')
  await page.getByTestId('hallucinate-pause').click()
  await expect(page.getByRole('alert')).toContainText('Wallpaper cancellation failed')
  await expect(page.getByRole('button', { name: 'Resume wallpaper' })).toBeEnabled()
  expect(events.some(event => event.startsWith('delete:'))).toBe(false)
  expect(submissions).toHaveLength(2)
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

for (const priority of ['normal', 'low', 'high'] as const) {
  test(`priority ${priority} applies to generation and upscale`, async ({ page }) => {
    const { submissions } = await mock(page, { isAdmin: true })
    const select = page.getByLabel('Priority', { exact: true })
    await expect(select).toHaveValue('normal')
    if (priority !== 'normal') await select.selectOption(priority)
    await page.getByLabel('Upscale before displaying').check()
    await page.getByTestId('hallucinate-start').click()
    await expect(page.getByTestId('hallucinate-display').getByRole('img').first()).toBeVisible()
    expect(submissions[0]).toMatchObject({ priority })
    expect(submissions[1]).toMatchObject({ priority })
    await page.getByTestId('hallucinate-pause').click()
    await expect(page.getByRole('button', { name: 'Resume wallpaper' })).toBeEnabled()
  })
}

test('non-admins can choose low or normal priority', async ({ page }) => {
  await mock(page)
  const select = page.getByLabel('Priority', { exact: true })
  await expect(select).toHaveValue('normal')
  await expect(select.getByRole('option')).toHaveCount(2)
  await select.selectOption('low')
  await expect(select).toHaveValue('low')
})

async function mockStudio(page: Page, options: { reply?: string; pending?: boolean; lateQueue?: boolean; offline?: boolean } = {}) {
  const turns: { content: string; chat_id: string }[] = []
  const chats: Record<string, unknown>[] = []
  const cancellations: string[] = []
  await page.routeWebSocket(/\/api\/ws\/chat/, ws => {
    ws.onMessage(raw => {
      const msg = JSON.parse(String(raw))
      if (msg.type === 'list_capabilities') ws.send(JSON.stringify({
        type: 'capabilities', req_id: msg.req_id,
        capabilities: options.offline ? [] : [{ base: 'llm.artist', tags: [], online: true }],
      }))
      if (msg.type === 'chat') {
        turns.push(msg)
        const queued = () => ws.send(JSON.stringify({ type: 'task:queued', req_id: msg.req_id, cap: 'llm.artist', id: 'prompt-1' }))
        if (options.lateQueue) setTimeout(queued, 500)
        else queued()
        if (!options.pending) ws.send(JSON.stringify({ type: 'task:result', req_id: msg.req_id, text: options.reply ?? '```\nA luminous glass forest\n```' }))
      }
    })
  })
  const base = await mock(page)
  await page.route('**/api/chats', route => {
    chats.push(route.request().postDataJSON())
    return route.fulfill({ json: { id: 'studio-wallpaper' } })
  })
  await page.route('**/api/tasks/cancel/**', route => {
    cancellations.push(route.request().url())
    return route.fulfill({ json: { status: 'canceled' } })
  })
  await page.getByTestId('hallucinate-mode').selectOption('studio')
  return { ...base, turns, chats, cancellations }
}

test('studio generates a fresh prompt before each image in the same slideshow', async ({ page }) => {
  const { submissions, turns, chats } = await mockStudio(page)
  await page.getByTestId('hallucinate-system').fill('Create image prompts only.')
  await page.getByTestId('hallucinate-template').fill('Imagine a variation of {prompt}')
  await page.getByTestId('hallucinate-prompt').fill('A {scene}')
  await page.getByTestId('hallucinate-start').click()
  await expect(page.getByTestId('hallucinate-display').getByRole('img').first()).toBeVisible()
  await expect.poll(() => submissions.length).toBeGreaterThanOrEqual(2)
  expect(chats).toEqual([{ kind: 'prompt_studio', system_prompt: 'Create image prompts only.', last_model: 'llm.artist' }])
  expect(turns[0]).toMatchObject({ chat_id: 'studio-wallpaper' })
  expect(turns[0].content).toMatch(/^Imagine a variation of A (moon garden|glass forest)$/)
  expect(turns[1].chat_id).toBe(turns[0].chat_id)
  expect(turns[1].content).not.toBe(turns[0].content)
  expect(submissions[0].prompt).toBe('A luminous glass forest')
  expect(submissions[1].prompt).toBe('A luminous glass forest')
  await page.getByTestId('hallucinate-pause').click()
  await expect(page.getByRole('button', { name: 'Resume wallpaper' })).toBeEnabled()
})

for (const lateQueue of [false, true]) {
  test(`Pause cancels prompt generation, late ID = ${lateQueue}`, async ({ page }) => {
    const { turns, submissions, cancellations } = await mockStudio(page, { pending: true, lateQueue })
    await page.getByTestId('hallucinate-start').click()
    await expect.poll(() => turns.length).toBe(1)
    await expect(page.getByTestId('hallucinate-job-status')).toContainText('Prompt')
    await page.getByTestId('hallucinate-pause').click()
    await expect(page.getByRole('button', { name: 'Resume wallpaper' })).toBeEnabled()
    expect(cancellations).toHaveLength(1)
    expect(submissions).toHaveLength(0)
    await expect(page.getByRole('alert')).toHaveCount(0)
  })
}

test('empty generated prompts stop visibly without rendering', async ({ page }) => {
  const { submissions } = await mockStudio(page, { reply: '```\n\n```' })
  await page.getByTestId('hallucinate-start').click()
  await expect(page.getByRole('alert')).toHaveText('The LLM returned an empty image prompt.')
  expect(submissions).toHaveLength(0)
})

test('studio needs an online LLM; direct mode remains available', async ({ page }) => {
  await mockStudio(page, { offline: true })
  await expect(page.getByTestId('hallucinate-start')).toBeDisabled()
  await page.getByTestId('hallucinate-mode').selectOption('direct')
  await expect(page.getByTestId('hallucinate-start')).toBeEnabled()
})
