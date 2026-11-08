import { expect, test, type Page } from '@playwright/test'

/**
 * Image generation stash: "Stash" under Generate multiple saves the request
 * without submitting a job; the "Stashed (N)" link opens a right drawer where an
 * entry can be started (removed from the stash, submitted, shown) or deleted.
 * Fully mocked — no backend needed.
 */

const now = '2026-11-08T12:00:00Z'

type Entry = { id: string; created_at: string; request: Record<string, unknown> }
type State = { stash: Entry[]; imageJobs: number; started: string[]; deleted: string[] }

async function mockApi(page: Page): Promise<State> {
  const state: State = { stash: [], imageJobs: 0, started: [], deleted: [] }
  let nextId = 1

  await page.addInitScript(() => localStorage.setItem('oai_token', 'test-token'))
  await page.route('**/api/**', async route => {
    const { pathname } = new URL(route.request().url())
    if (!pathname.startsWith('/api/')) return route.continue()
    const method = route.request().method()
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body })

    if (pathname === '/api/admin/am_i_admin') return json({ is_admin: false })
    if (pathname === '/api/me') {
      return json({ id: 1, login: 'tester', google_id: null, created_at: now, used_storage_bytes: 0 })
    }
    if (pathname === '/api/images/external-resize') return json({ available: false, threshold_bytes: 0 })
    if (pathname === '/api/images/capabilities') {
      return json([
        {
          base: 'imggen.flux',
          tags: ['txt2img'],
          raw: 'imggen.flux[txt2img]',
          online: true,
          last_available_at: now,
          usage_count: 0,
        },
      ])
    }
    if (pathname === '/api/admin/settings') return json({ client_api_token: 'x' })

    if (pathname === '/api/images/stash' && method === 'GET') return json(state.stash)
    if (pathname === '/api/images/stash' && method === 'POST') {
      const entry = { id: `s${nextId++}`, created_at: now, request: route.request().postDataJSON() }
      state.stash.unshift(entry)
      return json(entry, 201)
    }
    const stashItem = /^\/api\/images\/stash\/(s\d+)(\/start)?$/.exec(pathname)
    if (stashItem) {
      const [, id, start] = stashItem
      state.stash = state.stash.filter(e => e.id !== id)
      if (start) {
        state.started.push(id)
        state.imageJobs++
        return json({ job_id: `img-${state.imageJobs}`, status: 'submitted' }, 201)
      }
      state.deleted.push(id)
      return route.fulfill({ status: 204 })
    }

    if (pathname === '/api/images/jobs' && method === 'POST') {
      state.imageJobs++
      return json({ job_id: `img-${state.imageJobs}`, status: 'submitted' })
    }
    if (pathname === '/api/images/jobs' && method === 'GET') return json([])
    const imageJob = /^\/api\/images\/jobs\/(img-\d+)(\/poll)?$/.exec(pathname)
    if (imageJob) {
      if (imageJob[2]) {
        return json({ job_id: imageJob[1], status: 'pending', stage: null, error: null, output_images: [] })
      }
      return json({
        job_id: imageJob[1],
        display_name: imageJob[1],
        status: 'pending',
        prompt: 'stashed prompt',
        negative_prompt: null,
        capability: 'imggen.flux',
        workflow: 'txt2img',
        width: 1024,
        height: 1024,
        seed: null,
        input_image_id: null,
        pipeline_params: {},
        error: null,
        offload_cap: null,
        offload_task_id: null,
        files: [],
        events: [],
      })
    }

    if (pathname === '/api/progress/running') return json({ jobs: [] })
    if (pathname.startsWith('/api/prompts/')) return json({})
    if (pathname === '/api/prompt-placeholders') return json([])
    return route.fulfill({ status: 404, json: { error: 'Not mocked' } })
  })
  return state
}

test.describe('image generation stash', () => {
  test('stash saves without submitting; drawer starts and deletes entries', async ({ page }) => {
    const state = await mockApi(page)
    await page.goto('/app/images')

    await page.getByTestId('imggen-prompt').fill('a {color} fox')
    const stash = page.getByTestId('imggen-stash-add')
    await expect(stash).toBeEnabled()
    await stash.click()
    await expect.poll(() => state.stash.length).toBe(1)
    // Stored as typed — placeholders are expanded when the entry is started.
    expect(state.stash[0].request.prompt).toBe('a {color} fox')
    expect(state.stash[0].request.capability).toBe('imggen.flux')
    expect(state.imageJobs).toBe(0)

    await page.getByTestId('imggen-prompt').fill('a quiet lake')
    await stash.click()
    await expect(page.getByTestId('imggen-stash-open')).toHaveText('Stashed (2)')
    expect(state.imageJobs).toBe(0)

    await page.getByTestId('imggen-stash-open').click()
    const drawer = page.getByTestId('imggen-stash-drawer')
    await expect(drawer).toBeVisible()
    await expect(drawer.getByTestId('imggen-stash-item-s1')).toContainText('a {color} fox')
    await expect(drawer.getByTestId('imggen-stash-item-s2')).toContainText('a quiet lake')

    await drawer.getByTestId('imggen-stash-delete-s2').click()
    await expect(drawer.getByTestId('imggen-stash-item-s2')).toHaveCount(0)
    expect(state.deleted).toEqual(['s2'])

    await drawer.getByTestId('imggen-stash-start-s1').click()
    await expect(drawer.getByTestId('imggen-stash-empty')).toBeVisible()
    expect(state.started).toEqual(['s1'])

    // The started job is shown, like a normal Generate.
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('imggen-job-detail')).toBeVisible()
    await expect(page.getByTestId('imggen-pipeline-item-img-1')).toBeVisible()

    await page.getByTestId('imggen-pipeline-new').click()
    await expect(page.getByTestId('imggen-stash-open')).toHaveText('Stashed')
  })

  test('stash is never disabled; it explains what is missing', async ({ page }) => {
    const state = await mockApi(page)
    await page.goto('/app/images')

    await page.getByTestId('imggen-prompt').fill('')
    const stash = page.getByTestId('imggen-stash-add')
    await expect(page.getByTestId('imggen-submit-job')).toBeDisabled()
    await expect(stash).toBeEnabled()
    await stash.click()
    await expect(page.getByTestId('imggen-error')).toHaveText(/Enter a prompt/)
    expect(state.stash).toHaveLength(0)

    await page.getByTestId('imggen-prompt').fill('a cat')
    await stash.click()
    await expect.poll(() => state.stash.length).toBe(1)
  })

  test('start all submits every entry, oldest first', async ({ page }) => {
    const state = await mockApi(page)
    await page.goto('/app/images')

    for (const p of ['first', 'second', 'third']) {
      await page.getByTestId('imggen-prompt').fill(p)
      await page.getByTestId('imggen-stash-add').click()
      await expect.poll(() => state.stash.length).toBe(['first', 'second', 'third'].indexOf(p) + 1)
    }

    await page.getByTestId('imggen-stash-open').click()
    await page.getByTestId('imggen-stash-start-all').click()
    await expect(page.getByTestId('imggen-stash-empty')).toBeVisible()
    expect(state.started).toEqual(['s1', 's2', 's3'])
  })
})
