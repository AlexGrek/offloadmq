import { expect, test, type Page } from '@playwright/test'

/**
 * Background Remover (`/app/bg-remover`): model picker, output options, one job per image,
 * the cutout shown on a transparency checkerboard, result hints, "Adjust & re-run", and the
 * global Progress drawer. Fully mocked — no backend needed.
 */

const now = '2026-11-22T12:00:00Z'
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const PNG = Buffer.from(PNG_B64, 'base64')
const file = (name: string) => ({ name, mimeType: 'image/png', buffer: PNG })

const MODELS = ['birefnet-general', 'birefnet-lite', 'birefnet-portrait']
const DEFAULT_OPTIONS = {
  format: 'png',
  background: 'transparent',
  crop: false,
  padding: 0,
  refine_foreground: true,
  alpha_threshold: null,
  quality: null,
}

type Captured = { uploads: string[]; starts: Record<string, unknown>[] }

type MockOpts = {
  models?: string[]
  /** Status the mocked job reports. */
  status?: string
  foregroundRatio?: number | null
  runningProgressRow?: boolean
}

function jobView(n: number, captured: Captured, opts: MockOpts) {
  const start = captured.starts[n - 1] ?? {}
  const completed = (opts.status ?? 'completed') === 'completed'
  return {
    job_id: `job-${n}`,
    status: opts.status ?? 'completed',
    capability: (start.capability as string) ?? 'onnx.bgremove.birefnet-general',
    model: ((start.capability as string) ?? 'onnx.bgremove.birefnet-general').replace('onnx.bgremove.', ''),
    input_image_id: '100',
    output_image_id: completed ? '200' : null,
    input_image: {
      image_id: '100', filename: 'hero.png', content_type: 'image/jpeg', width: 832, height: 1216,
      size_bytes: 68, rescaled: false, reencoded: false, direction: 'input',
    },
    output_image: completed
      ? {
          image_id: '200', filename: 'hero_cutout.png', content_type: 'image/png', width: 512, height: 1100,
          size_bytes: 68, rescaled: false, reencoded: false, direction: 'output',
        }
      : null,
    options: { ...DEFAULT_OPTIONS, ...((start.options as object) ?? {}) },
    foreground_ratio: completed ? (opts.foregroundRatio === undefined ? 0.31 : opts.foregroundRatio) : null,
    stage: null,
    error: null,
    offload_cap: 'onnx.bgremove.birefnet-general',
    offload_task_id: `t-${n}`,
    started_at: now,
    typical_runtime_seconds: 10,
    created_at: now,
    updated_at: now,
  }
}

async function mockApi(page: Page, opts: MockOpts = {}): Promise<Captured> {
  const captured: Captured = { uploads: [], starts: [] }
  let nextImage = 100
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
    if (pathname === '/api/progress/running') {
      return json({
        jobs: opts.runningProgressRow
          ? [{
              key: 'bg-remover:77', source: 'bg-remover', label: 'Remove background', status: 'running',
              stage: null, job_id: '77', offload_cap: 'onnx.bgremove.birefnet-general', offload_task_id: 't-77',
              started_at: now, typical_runtime_seconds: 10, submitted_at: now,
            }]
          : [],
      })
    }
    if (pathname === '/api/bg-remover/capabilities') {
      const models = opts.models ?? MODELS
      return json({
        capabilities: models.map(m => ({ base: `onnx.bgremove.${m}`, model: m, raw: `onnx.bgremove.${m}` })),
        default_model: 'birefnet-general',
      })
    }
    if (pathname === '/api/images/upload' && method === 'POST') {
      const body = route.request().postDataBuffer()?.toString('latin1') ?? ''
      const filename = /filename="([^"]+)"/.exec(body)?.[1] ?? 'unknown.png'
      captured.uploads.push(filename)
      return json({
        image_id: String(nextImage++), filename, content_type: 'image/png', width: 1, height: 1,
        size_bytes: 68, rescaled: false, reencoded: false,
      })
    }
    if (pathname === '/api/bg-remover/jobs' && method === 'POST') {
      captured.starts.push(route.request().postDataJSON())
      return json({ job_id: `job-${captured.starts.length}`, status: 'submitted' }, 201)
    }
    if (pathname === '/api/bg-remover/jobs' && method === 'GET') {
      return json(captured.starts.map((_, i) => jobView(i + 1, captured, opts)).reverse())
    }
    const job = /^\/api\/bg-remover\/jobs\/job-(\d+)(\/poll)?$/.exec(pathname)
    if (job) return json(jobView(Number(job[1]), captured, opts))
    if (pathname === '/api/bg-remover/jobs/77/poll') return json({ job_id: '77', status: 'running' })
    if (pathname.startsWith('/api/images/files/')) {
      return route.fulfill({ status: 200, contentType: 'image/png', body: PNG })
    }
    return json({})
  })
  return captured
}

test('models are listed with the default first and selected', async ({ page }) => {
  await mockApi(page)
  await page.goto('/app/bg-remover')

  const picker = page.getByTestId('bgremover-model-picker')
  await expect(picker.getByRole('button', { name: /BiRefNet/ })).toHaveCount(3)
  // The default model is preselected: the submit goes out with it.
  await expect(page.getByTestId('bgremover-model-birefnet-general')).toHaveClass(/bg-primary/)
  await expect(page.getByTestId('bgremover-submit')).toBeDisabled()
})

test('no model online: explains how to install one and cannot submit', async ({ page }) => {
  await mockApi(page, { models: [] })
  await page.goto('/app/bg-remover')

  await expect(page.getByTestId('bgremover-no-models')).toContainText('bgremove-birefnet-general')
  await page.getByTestId('bgremover-input-file-input').setInputFiles([file('a.png')])
  await expect(page.getByTestId('bgremover-input-thumb')).toHaveCount(1)
  await expect(page.getByTestId('bgremover-submit')).toBeDisabled()
})

test('several images → one job each, with the chosen model and options', async ({ page }) => {
  const captured = await mockApi(page)
  await page.goto('/app/bg-remover')

  await page.getByTestId('bgremover-model-birefnet-portrait').click()
  await page.getByTestId('bgremover-crop').check()
  await page.getByTestId('bgremover-padding').fill('16')
  await page.getByTestId('bgremover-input-file-input').setInputFiles([file('a.png'), file('b.png')])
  await expect(page.getByTestId('bgremover-input-thumb')).toHaveCount(2)

  const run = page.getByTestId('bgremover-submit')
  await expect(run).toContainText('from 2 images')
  await expect(run).toBeEnabled()
  await run.click()

  await expect.poll(() => captured.starts.length).toBe(2)
  const [a, b] = captured.starts
  expect(a.input_image_id).not.toEqual(b.input_image_id)
  for (const start of [a, b]) {
    expect(start).toMatchObject({
      capability: 'onnx.bgremove.birefnet-portrait',
      options: { format: 'png', background: 'transparent', crop: true, padding: 16, refine_foreground: true },
    })
  }
  await expect(page.getByTestId('bgremover-job-detail')).toBeVisible()
})

test('JPEG cannot be transparent: choosing it switches to a solid colour', async ({ page }) => {
  const captured = await mockApi(page)
  await page.goto('/app/bg-remover')

  await page.getByTestId('bgremover-format-jpeg').click()
  await expect(page.getByTestId('bgremover-bg-transparent')).toBeDisabled()
  await expect(page.getByTestId('bgremover-bg-hex')).toHaveValue('#FFFFFF')

  await page.getByTestId('bgremover-bg-hex').fill('#2b2b35')
  await page.getByTestId('bgremover-input-file-input').setInputFiles([file('a.png')])
  await expect(page.getByTestId('bgremover-input-thumb')).toHaveCount(1)
  await page.getByTestId('bgremover-submit').click()

  await expect.poll(() => captured.starts.length).toBe(1)
  expect(captured.starts[0]).toMatchObject({ options: { format: 'jpeg', background: '#2B2B35' } })
})

test('a bad hex colour blocks the submit with a message', async ({ page }) => {
  await mockApi(page)
  await page.goto('/app/bg-remover')

  await page.getByTestId('bgremover-bg-color').click()
  await page.getByTestId('bgremover-bg-hex').fill('#12')
  await page.getByTestId('bgremover-input-file-input').setInputFiles([file('a.png')])
  await expect(page.getByTestId('bgremover-input-thumb')).toHaveCount(1)

  await expect(page.getByTestId('bgremover-options-error')).toContainText('#RRGGBB')
  await expect(page.getByTestId('bgremover-submit')).toBeDisabled()
})

test('a completed job shows the cutout on a checkerboard and can be adjusted and re-run', async ({ page }) => {
  await mockApi(page)
  await page.goto('/app/bg-remover')

  await page.getByTestId('bgremover-input-file-input').setInputFiles([file('hero.png')])
  await expect(page.getByTestId('bgremover-input-thumb')).toHaveCount(1)
  await page.getByTestId('bgremover-format-webp').click()
  await page.getByTestId('bgremover-submit').click()

  const image = page.getByTestId('bgremover-job-image')
  await expect(image).toBeVisible()
  await expect(image).toHaveClass(/bg-checkerboard/)
  await expect(page.getByTestId('bgremover-options-summary')).toContainText('832×1216 → 512×1100')
  await expect(page.getByTestId('bgremover-warning')).toHaveCount(0)
  await expect(page.getByTestId('bgremover-download-job')).toBeVisible()

  await page.getByTestId('bgremover-compare-toggle').click()
  await expect(page.getByTestId('bgremover-compare-view')).toBeVisible()

  // Back to the form with the same picture and settings, to iterate on them.
  await page.getByTestId('bgremover-adjust').click()
  await expect(page.getByTestId('bgremover-new-panel')).toBeVisible()
  await expect(page.getByTestId('bgremover-input-thumb')).toHaveCount(1)
  await expect(page.getByTestId('bgremover-submit')).toBeEnabled()
})

test('a result with almost nothing kept warns and suggests another model', async ({ page }) => {
  await mockApi(page, { foregroundRatio: 0.001 })
  await page.goto('/app/bg-remover')

  await page.getByTestId('bgremover-input-file-input').setInputFiles([file('hero.png')])
  await expect(page.getByTestId('bgremover-input-thumb')).toHaveCount(1)
  await page.getByTestId('bgremover-submit').click()

  await expect(page.getByTestId('bgremover-warning')).toContainText('Almost nothing was kept')
})

test('background removal jobs show in the progress drawer', async ({ page }) => {
  await mockApi(page, { runningProgressRow: true })
  await page.goto('/app/bg-remover')

  const toggle = page.getByTestId('progress-toggle')
  await expect(toggle).toContainText('1')
  await toggle.click()

  const drawer = page.getByTestId('progress-drawer')
  await expect(drawer.getByTestId('progress-row-bg-remover:77')).toContainText('Remove background')
  await expect(drawer.getByTestId('progress-panel').filter({ hasText: 'Background remover' })).toContainText(
    'Remove background',
  )
})

for (const [status, phase] of [['running', 'determinate'], ['pending', 'indeterminate']] as const) {
  test(`win98 theme draws a ${phase} progress bar as navy blocks in a sunken well`, async ({ page }) => {
    await mockApi(page, { status })
    await page.addInitScript(() => localStorage.setItem('oai_theme', 'win98'))
    await page.goto('/app/bg-remover')

    await page.getByTestId('bgremover-input-file-input').setInputFiles([file('hero.png')])
    await page.getByTestId('bgremover-submit').click()

    const bar = page.getByTestId('imggen-progress-bar')
    await expect(bar).toHaveAttribute('data-progress-phase', phase)
    const look = await bar.evaluate(el => {
      const track = el.querySelector<HTMLElement>('[data-slot="job-progress-track"]')!
      const blocks = el.querySelector<HTMLElement>('[data-slot="job-progress-fill"], [data-slot="job-progress-sweep"]')!
      const t = getComputedStyle(track)
      return {
        height: t.height,
        radius: t.borderTopLeftRadius,
        bevel: getComputedStyle(track, '::after').boxShadow,
        background: getComputedStyle(blocks).backgroundImage,
        width: blocks.getBoundingClientRect().width,
      }
    })
    expect(look.height).toBe('20px')
    expect(look.radius).toBe('0px')
    expect(look.bevel).toContain('inset')
    expect(look.background).toContain('repeating-linear-gradient')
    // Blocks are 10px + 2px gap: the run is always a whole number of them.
    expect(look.width % 12).toBe(0)
    expect(look.width).toBeGreaterThan(0)
    await bar.screenshot({ path: `/tmp/win98-progress-${phase}.png` })
  })
}
