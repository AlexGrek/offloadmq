import { expect, test, type Page } from '@playwright/test'

function job(id: string, contentType = 'image/svg+xml') {
  return {
    job_id: id, display_name: `job-${id}`, status: 'completed', prompt: `Prompt ${id}`,
    negative_prompt: null, capability: 'imggen.test', workflow: 'txt2img', width: 32, height: 16,
    seed: null, input_image_id: null, pipeline_params: null, error: null,
    offload_cap: null, offload_task_id: null, events: [],
    files: [{ image_id: id, direction: 'output', source: 'imggen', filename: `image-${id}`,
      content_type: contentType, width: 32, height: 16, size_bytes: 100, rescaled: false, reencoded: false }],
  }
}

async function setup(page: Page, theme = 'dark') {
  let jobs = [job('old')]
  const mutations: string[] = []
  let refreshes = 0
  let failRefresh = false
  await page.addInitScript(theme => {
    localStorage.setItem('oai_token', 'test-token')
    localStorage.setItem('oai_theme', theme)
  }, theme)
  page.on('pageerror', error => { throw error })
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname
    if (!path.startsWith('/api/')) return route.continue()
    if (route.request().method() !== 'GET') mutations.push(path)
    const json = (body: unknown) => route.fulfill({ json: body })
    if (path === '/api/me') return json({ id: 1, login: 'tester', used_storage_bytes: 0 })
    if (path === '/api/images/jobs') {
      refreshes++
      if (failRefresh) { failRefresh = false; return route.fulfill({ status: 503, json: { error: 'Temporarily unavailable' } }) }
      return json(jobs)
    }
    if (path === '/api/images/capabilities' || path === '/api/images/stash') return json([])
    if (path === '/api/images/external-resize') return json({ available: false, threshold_bytes: 0 })
    if (path === '/api/progress/running') return json({ jobs: [] })
    if (path === '/api/admin/am_i_admin') return json({ is_admin: false })
    if (path.startsWith('/api/images/files/')) return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="16"><path fill="#8b5cf6" d="M0 0h32v16H0z"/><circle fill="#67e8f9" cx="16" cy="8" r="6"/></svg>' })
    return json({})
  })
  await page.goto('/app/images')
  await expect(page.getByTestId('imggen-pipeline-item-old')).toBeAttached()
  if (!await page.getByTestId('imggen-slideshow-toggle').isVisible()) await page.getByTitle('Open sidebar', { exact: true }).click()
  await page.clock.install()
  await page.getByTestId('imggen-slideshow-toggle').click()
  await expect(page.getByTestId('imggen-slideshow')).toBeVisible()
  return {
    add: (id: string, type?: string) => { jobs = [job(id, type), ...jobs] },
    failNextRefresh: () => { failRefresh = true },
    tick: async () => {
      const previous = refreshes
      await page.clock.runFor(5100)
      await expect.poll(() => refreshes).toBeGreaterThan(previous)
    },
    mutations,
  }
}

test('slideshow waits for new images, pauses display without controlling jobs, and resumes queued images in order', async ({ page }) => {
  const api = await setup(page)
  const viewer = page.getByTestId('imggen-slideshow')
  const image = page.getByTestId('imggen-slideshow-image')
  await expect(viewer.getByRole('status')).toHaveText('Waiting for new images')
  await expect(image).toHaveCount(0)
  await expect(viewer.getByRole('button')).toHaveCount(3)
  await expect(viewer.getByRole('progressbar')).toHaveCount(0)
  api.add('first')
  await api.tick()
  await expect(image).toHaveAttribute('alt', 'image-first')
  await page.mouse.move(100, 100)
  await page.getByTestId('imggen-slideshow-pause').click()
  await expect(viewer.getByRole('status')).toContainText('Paused')
  api.add('second')
  await api.tick()
  api.add('video', 'video/mp4')
  api.add('third')
  await api.tick()
  await expect(image).toHaveAttribute('alt', 'image-first')
  await expect(page.getByRole('button', { name: 'Resume slideshow' })).toBeVisible()
  expect(api.mutations).toEqual([])
  await page.getByTestId('imggen-slideshow-pause').click()
  api.failNextRefresh()
  await api.tick()
  await expect(image).toHaveAttribute('alt', 'image-second')
  await api.tick()
  await expect(image).toHaveAttribute('alt', 'image-third')
  await page.keyboard.press('Escape')
  await expect(viewer).toHaveCount(0)
  await expect(page.getByTestId('imggen-slideshow-toggle')).toHaveAttribute('aria-pressed', 'false')
})

for (const [width, height, theme] of [[390, 844, 'light'], [1280, 720, 'dark']] as const) {
  test(`slideshow enlarges small images with aspect ratio preserved at ${width}px and hides idle controls`, async ({ page }) => {
    await page.setViewportSize({ width, height })
    const api = await setup(page, theme)
    api.add('small')
    await api.tick()
    const image = page.getByTestId('imggen-slideshow-image')
    await expect(image).toHaveAttribute('alt', 'image-small')
    await expect.poll(() => image.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(32)
    const geometry = await image.evaluate(el => ({ width: el.clientWidth, height: el.clientHeight, fit: getComputedStyle(el).objectFit }))
    expect(geometry).toEqual({ width, height, fit: 'contain' })
    const controls = page.getByTestId('imggen-slideshow-controls')
    await page.mouse.move(100, 100)
    await expect(controls).toHaveCSS('opacity', '1')
    await page.clock.runFor(4500)
    await expect(controls).toHaveCSS('opacity', '0')
    await page.mouse.move(110, 110)
    await expect(controls).toHaveCSS('opacity', '1')
    await page.getByTestId('imggen-slideshow-pause').click()
    await page.clock.runFor(4500)
    await expect(controls).toHaveCSS('opacity', '1')
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0)
    await page.getByTestId('imggen-slideshow-close').click()
    await expect(page.getByTestId('imggen-slideshow')).toHaveCount(0)
  })
}

test('fullscreen targets the slideshow surface and can be exited from its own menu', async ({ page }) => {
  await setup(page)
  await page.getByTestId('imggen-slideshow-fullscreen').click()
  await expect.poll(() => page.evaluate(() => document.fullscreenElement?.getAttribute('data-testid'))).toBe('imggen-slideshow')
  await expect(page.getByRole('button', { name: 'Exit browser fullscreen' })).toBeVisible()
  await page.getByTestId('imggen-slideshow-fullscreen').click()
  await expect.poll(() => page.evaluate(() => document.fullscreenElement)).toBe(null)
  await expect(page.getByTestId('imggen-slideshow')).toBeVisible()
})

test('fullscreen rejection leaves a usable window-sized viewer', async ({ page }) => {
  await page.addInitScript(() => {
    Element.prototype.requestFullscreen = () => Promise.reject(new Error('Fullscreen denied'))
  })
  await setup(page)
  await page.getByTestId('imggen-slideshow-fullscreen').click()
  await expect(page.getByRole('alert')).toContainText('Browser fullscreen is unavailable')
  await page.getByTestId('imggen-slideshow-pause').click()
  await expect(page.getByRole('button', { name: 'Resume slideshow' })).toBeVisible()
})
