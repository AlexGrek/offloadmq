import { expect, test } from '@playwright/test'

/**
 * Image Tools jobs in the global Progress drawer: the `/api/progress/running` feed
 * carries `source: "img-utils"` rows, which get their own panel, count toward the
 * top-bar badge, are advanced by the shell's background poll and can be canceled.
 * Fully mocked — no backend needed.
 */

const now = '2026-11-08T12:00:00Z'

test('image tool jobs show in the progress drawer and can be canceled', async ({ page }) => {
  let running = true
  let polls = 0
  let canceled = false

  await page.addInitScript(() => localStorage.setItem('oai_token', 'test-token'))
  await page.route('**/api/**', async route => {
    const { pathname } = new URL(route.request().url())
    if (!pathname.startsWith('/api/')) return route.continue()
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body })

    if (pathname === '/api/admin/am_i_admin') return json({ is_admin: false })
    if (pathname === '/api/me') {
      return json({ id: 1, login: 'tester', google_id: null, created_at: now, used_storage_bytes: 0 })
    }
    if (pathname === '/api/progress/running') {
      return json({
        jobs: running
          ? [
              {
                key: 'img-utils:77',
                source: 'img-utils',
                label: 'Upscale · seedvr2_upscale_image',
                status: 'running',
                stage: 'sampling',
                job_id: '77',
                offload_cap: 'img-utils.seedvr2_upscale_image',
                offload_task_id: 't-77',
                started_at: now,
                typical_runtime_seconds: 30,
                submitted_at: now,
              },
            ]
          : [],
      })
    }
    if (pathname === '/api/img-utils/jobs/77/poll') {
      polls++
      return json({ job_id: '77', status: 'running' })
    }
    if (pathname === '/api/img-utils/jobs/77/cancel') {
      canceled = true
      running = false
      return json({ status: 'canceled' })
    }
    if (pathname === '/api/img-utils/capabilities') return json({ capabilities: [] })
    if (pathname === '/api/img-utils/jobs') return json([])
    return route.fulfill({ status: 404, json: { error: 'Not mocked' } })
  })

  await page.goto('/app/img-utils')

  const toggle = page.getByTestId('progress-toggle')
  await expect(toggle).toContainText('1')
  await toggle.click()

  const drawer = page.getByTestId('progress-drawer')
  const row = drawer.getByTestId('progress-row-img-utils:77')
  await expect(row).toContainText('Upscale · seedvr2_upscale_image')
  await expect(drawer.getByTestId('progress-panel').filter({ hasText: 'Image tools' })).toContainText(
    'Upscale',
  )

  // The shell keeps the job moving even though this page isn't viewing it.
  await expect.poll(() => polls, { timeout: 12_000 }).toBeGreaterThan(0)

  await drawer.getByTestId('progress-cancel-img-utils:77').click()
  await expect.poll(() => canceled).toBe(true)
  await expect(row).toHaveCount(0)
  await expect(drawer).toContainText('No image tool jobs in progress.')
})
