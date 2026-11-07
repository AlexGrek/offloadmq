import { expect, test, type Page } from '@playwright/test'

/**
 * "High priority" checkbox on the image generation form (admin-only): sends
 * `high_priority` on submit and labels high-priority jobs in the job detail;
 * hidden and never sent for non-admins. Fully mocked — no backend needed.
 */

const now = '2026-11-07T12:00:00Z'

type Captured = { imageJobs: Record<string, unknown>[] }

async function mockApi(page: Page, { isAdmin }: { isAdmin: boolean }): Promise<Captured> {
  const captured: Captured = { imageJobs: [] }

  await page.addInitScript(() => localStorage.setItem('oai_token', 'test-token'))
  await page.route('**/api/**', async route => {
    const { pathname } = new URL(route.request().url())
    if (!pathname.startsWith('/api/')) return route.continue()
    const method = route.request().method()
    const json = (body: unknown) => route.fulfill({ json: body })

    if (pathname === '/api/admin/am_i_admin') return json({ is_admin: isAdmin })
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

    if (pathname === '/api/images/jobs' && method === 'POST') {
      captured.imageJobs.push(route.request().postDataJSON() as Record<string, unknown>)
      return json({ job_id: `img-${captured.imageJobs.length}`, status: 'submitted' })
    }
    if (pathname === '/api/images/jobs' && method === 'GET') return json([])
    const imageJob = /^\/api\/images\/jobs\/(img-\d+)(\/poll)?$/.exec(pathname)
    if (imageJob) {
      const req = captured.imageJobs[Number(imageJob[1].split('-')[1]) - 1] ?? {}
      if (imageJob[2]) {
        return json({ job_id: imageJob[1], status: 'pending', stage: null, error: null, output_images: [] })
      }
      return json({
        job_id: imageJob[1],
        display_name: imageJob[1],
        status: 'pending',
        prompt: req.prompt ?? '',
        negative_prompt: null,
        capability: req.capability ?? '',
        workflow: 'txt2img',
        width: req.width ?? 0,
        height: req.height ?? 0,
        seed: null,
        input_image_id: null,
        // The backend only writes the flag into the snapshot when it is set.
        pipeline_params: req.high_priority ? { high_priority: true } : {},
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
  return captured
}

async function submitPrompt(page: Page, prompt: string) {
  await page.getByTestId('imggen-prompt').fill(prompt)
  const submit = page.getByTestId('imggen-submit-job')
  await expect(submit).toBeEnabled()
  await submit.click()
}

test.describe('image generation priority', () => {
  test('admin: regular by default, high when ticked; detail labels high-priority jobs', async ({ page }) => {
    const captured = await mockApi(page, { isAdmin: true })
    await page.goto('/app/images')

    const checkbox = page.getByTestId('imggen-high-priority-checkbox')
    await expect(checkbox).not.toBeChecked()

    await submitPrompt(page, 'a regular cat')
    await expect.poll(() => captured.imageJobs.length).toBe(1)
    expect(captured.imageJobs[0].high_priority).toBe(false)
    await expect(page.getByTestId('imggen-job-detail')).toBeVisible()
    await expect(page.getByTestId('imggen-job-high-priority')).toBeHidden()

    await page.getByTestId('imggen-pipeline-new').click()
    await checkbox.check()
    await submitPrompt(page, 'an urgent cat')
    await expect.poll(() => captured.imageJobs.length).toBe(2)
    expect(captured.imageJobs[1].high_priority).toBe(true)
    await expect(page.getByTestId('imggen-job-high-priority')).toHaveText(/High priority/)
  })

  test('non-admin: no checkbox, always submits regular', async ({ page }) => {
    const captured = await mockApi(page, { isAdmin: false })
    await page.goto('/app/images')

    await submitPrompt(page, 'a cat')
    await expect.poll(() => captured.imageJobs.length).toBe(1)
    expect(captured.imageJobs[0].high_priority).toBe(false)
    await expect(page.getByTestId('imggen-high-priority')).toHaveCount(0)
  })
})
