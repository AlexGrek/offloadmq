import { expect, test, type Page } from '@playwright/test'

/**
 * Multi-image input: img2img / img2video and Describe image take several input
 * images and submit one job per image. Fully mocked — no backend needed.
 */

const now = '2026-10-03T12:00:00Z'

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

/** Stored dimensions the mocked upload reports, keyed by filename. */
const DIMS: Record<string, [number, number]> = {
  'wide.png': [2000, 1000],
  'tall.png': [600, 900],
  'huge.png': [5000, 2500],
  'third.png': [800, 800],
}

function file(name: string) {
  return { name, mimeType: 'image/png', buffer: PNG }
}

type Captured = { uploads: string[]; imageJobs: Record<string, unknown>[]; describeJobs: Record<string, unknown>[] }

async function mockApi(page: Page): Promise<Captured> {
  const captured: Captured = { uploads: [], imageJobs: [], describeJobs: [] }
  let nextId = 100
  const uploadedById = new Map<string, { filename: string; width: number; height: number }>()

  await page.addInitScript(() => localStorage.setItem('oai_token', 'test-token'))
  await page.route('**/api/**', async route => {
    const { pathname } = new URL(route.request().url())
    if (!pathname.startsWith('/api/')) return route.continue()
    const method = route.request().method()
    const json = (body: unknown) => route.fulfill({ json: body })

    if (pathname === '/api/me') {
      return json({ id: 1, login: 'tester', google_id: null, created_at: now, used_storage_bytes: 0 })
    }
    if (pathname === '/api/images/upload' && method === 'POST') {
      const body = route.request().postDataBuffer()?.toString('latin1') ?? ''
      const filename = /filename="([^"]+)"/.exec(body)?.[1] ?? 'unknown.png'
      captured.uploads.push(filename)
      const [width, height] = DIMS[filename] ?? [1, 1]
      const imageId = String(nextId++)
      uploadedById.set(imageId, { filename, width, height })
      return json({
        image_id: imageId,
        filename,
        content_type: 'image/png',
        width,
        height,
        size_bytes: 68,
        rescaled: false,
        reencoded: false,
      })
    }
    if (pathname === '/api/images/external-resize') return json({ available: false, threshold_bytes: 0 })
    if (pathname === '/api/images/capabilities') {
      return json([
        {
          base: 'imggen.flux',
          tags: ['txt2img', 'img2img', 'img2video'],
          raw: 'imggen.flux[txt2img;img2img;img2video]',
          online: true,
          last_available_at: now,
          usage_count: 0,
        },
      ])
    }
    if (pathname === '/api/admin/settings') return json({ client_api_token: 'x' })

    // Image generation jobs
    if (pathname === '/api/images/jobs' && method === 'POST') {
      const req = route.request().postDataJSON() as Record<string, unknown>
      captured.imageJobs.push(req)
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
        workflow: req.workflow ?? 'img2img',
        width: req.width ?? 0,
        height: req.height ?? 0,
        seed: null,
        input_image_id: req.input_image_id ?? null,
        pipeline_params: {},
        error: null,
        offload_cap: null,
        offload_task_id: null,
        files: [],
        events: [],
      })
    }

    // Describe jobs
    if (pathname === '/api/describe/capabilities') {
      return json({
        capabilities: [
          { base: 'llm.qwen-vl', tags: ['vision'], raw: 'llm.qwen-vl[vision]', online: true, last_available_at: now, usage_count: 0 },
        ],
      })
    }
    const describeJobView = (index: number) => {
      const req = captured.describeJobs[index]
      return {
        job_id: `desc-${index + 1}`,
        status: 'pending',
        prompt: req.prompt,
        capability: req.capability,
        input_image_id: req.image_id,
        result: null,
        stage: null,
        error: null,
        offload_cap: null,
        offload_task_id: null,
        created_at: now,
        updated_at: now,
      }
    }
    if (pathname === '/api/describe/jobs' && method === 'POST') {
      captured.describeJobs.push(route.request().postDataJSON() as Record<string, unknown>)
      return json({ job_id: `desc-${captured.describeJobs.length}`, status: 'submitted' })
    }
    if (pathname === '/api/describe/jobs' && method === 'GET') {
      return json(captured.describeJobs.map((_, i) => describeJobView(i)).reverse())
    }
    const describeJob = /^\/api\/describe\/jobs\/desc-(\d+)(\/poll)?$/.exec(pathname)
    if (describeJob) return json(describeJobView(Number(describeJob[1]) - 1))

    if (pathname === '/api/files/images') {
      const libraryFile = (id: string, filename: string, width: number, height: number) => ({
        id, kind: 'image', direction: 'output', source: 'image', filename,
        content_type: 'image/jpeg', width, height, size_bytes: 1000, sha256: '', job_id: null,
        created_at: now, url: '', thumbnail_url: '', is_image: true, is_video: false,
        is_audio: false, is_starred: false,
      })
      return json({
        files: [libraryFile('lib-1', 'one.jpg', 1024, 768), libraryFile('lib-2', 'two.jpg', 768, 1024)],
        has_more: false,
      })
    }
    if (pathname === '/api/progress/running') return json({ jobs: [] })
    if (pathname.startsWith('/api/prompts/')) return json({})
    if (pathname === '/api/prompt-placeholders') return json([])
    return route.fulfill({ status: 404, json: { error: 'Not mocked' } })
  })
  return captured
}

async function openImg2Img(page: Page) {
  await page.goto('/app/images')
  await page.getByTestId('imggen-mode-img2img').click()
  await expect(page.getByTestId('imggen-input-section')).toBeVisible()
}

test.describe('img2img with several input images', () => {
  test('one job per image, each at its own original resolution; Generate multiple disabled', async ({ page }) => {
    const captured = await mockApi(page)
    await openImg2Img(page)

    await page.getByTestId('imggen-upload-input').setInputFiles([file('wide.png'), file('tall.png')])

    await expect(page.getByTestId('imggen-input-grid')).toBeVisible()
    await expect(page.locator('[data-testid^="imggen-input-thumb-"]')).toHaveCount(2)
    await expect(page.getByTestId('imggen-generate-multiple-open')).toBeDisabled()
    await expect(page.getByTestId('imggen-original-resolution')).toBeChecked()

    const submit = page.getByTestId('imggen-submit-job')
    await expect(submit).toHaveText('Edit 2 Images')
    await submit.click()

    await expect.poll(() => captured.imageJobs.length).toBe(2)
    const [a, b] = captured.imageJobs
    expect(a.input_image_id).not.toEqual(b.input_image_id)
    expect([a.width, a.height]).toEqual([2000, 1000])
    expect([b.width, b.height]).toEqual([600, 900])
    expect(a.data_preparation).toBeNull()
    await expect(page.getByTestId('imggen-job-detail')).toBeVisible()
  })

  test('inputs over 4K fall back to keep-proportions at the form long edge', async ({ page }) => {
    const captured = await mockApi(page)
    await openImg2Img(page)

    await page.getByTestId('imggen-upload-input').setInputFiles([file('huge.png'), file('tall.png')])
    await expect(page.locator('[data-testid^="imggen-input-thumb-"]')).toHaveCount(2)
    // Not every input is under 4K, so original resolution isn't offered.
    await expect(page.getByTestId('imggen-original-resolution')).toBeHidden()
    await expect(page.getByTestId('imggen-multi-input-dims-hint')).toContainText('1024px long edge')

    await page.getByTestId('imggen-submit-job').click()
    await expect.poll(() => captured.imageJobs.length).toBe(2)
    const [a, b] = captured.imageJobs
    expect([a.width, a.height]).toEqual([1024, 512])
    expect([b.width, b.height]).toEqual([680, 1024])
  })

  test('removing images back to one restores the single-image form', async ({ page }) => {
    const captured = await mockApi(page)
    await openImg2Img(page)

    await page.getByTestId('imggen-upload-input').setInputFiles([file('wide.png'), file('tall.png')])
    await expect(page.locator('[data-testid^="imggen-input-thumb-"]')).toHaveCount(2)
    await page.locator('[data-testid^="imggen-input-remove-"]').first().click()

    await expect(page.getByTestId('imggen-input-grid')).toBeHidden()
    await expect(page.getByTestId('imggen-input-preview')).toBeVisible()
    await expect(page.getByTestId('imggen-submit-job')).toHaveText('Edit Image')
    await expect(page.getByTestId('imggen-generate-multiple-open')).toBeEnabled()

    await page.getByTestId('imggen-submit-job').click()
    await expect.poll(() => captured.imageJobs.length).toBe(1)
    expect([captured.imageJobs[0].width, captured.imageJobs[0].height]).toEqual([600, 900])
  })

  test('a second upload appends to the set', async ({ page }) => {
    await mockApi(page)
    await openImg2Img(page)

    await page.getByTestId('imggen-upload-input').setInputFiles([file('wide.png')])
    await expect(page.getByTestId('imggen-input-preview')).toBeVisible()
    await page.getByTestId('imggen-upload-input').setInputFiles([file('tall.png')])

    await expect(page.locator('[data-testid^="imggen-input-thumb-"]')).toHaveCount(2)
    await expect(page.getByTestId('imggen-submit-job')).toHaveText('Edit 2 Images')
    await page.getByTestId('imggen-input-clear').click()
    await expect(page.getByTestId('imggen-input-grid')).toBeHidden()
    await expect(page.getByTestId('imggen-submit-job')).toBeDisabled()
  })
})

test('library picker multi-selects images into the input set', async ({ page }) => {
  const captured = await mockApi(page)
  await openImg2Img(page)

  await page.getByTestId('imggen-pick-from-library').click()
  await page.getByTestId('imggen-picker-file-lib-1').click()
  await page.getByTestId('imggen-picker-file-lib-2').click()
  await expect(page.getByTestId('imggen-picker-selected-count')).toHaveText('2 selected')
  const confirm = page.getByTestId('imggen-picker-confirm')
  await expect(confirm).toHaveText('Use 2 images')
  await confirm.click()

  await expect(page.locator('[data-testid^="imggen-input-thumb-"]')).toHaveCount(2)
  await page.getByTestId('imggen-submit-job').click()
  await expect.poll(() => captured.imageJobs.length).toBe(2)
  expect(captured.imageJobs.map(j => j.input_image_id)).toEqual(['lib-1', 'lib-2'])
})

test.describe('Describe image with several input images', () => {
  test('one analysis per image, with remove and add-back', async ({ page }) => {
    const captured = await mockApi(page)
    await page.goto('/app/describe')
    await expect(page.getByTestId('describe-drop-zone')).toBeVisible()

    await page.getByTestId('describe-upload-input').setInputFiles([file('wide.png'), file('tall.png')])
    await expect(page.getByTestId('describe-input-grid')).toBeVisible()
    await expect(page.locator('[data-testid^="describe-input-thumb-"]')).toHaveCount(2)

    // Back to one image → the single preview, then add another.
    await page.locator('[data-testid^="describe-input-remove-"]').first().click()
    await expect(page.getByTestId('describe-image-preview')).toBeVisible()
    await page.getByTestId('describe-upload-input').setInputFiles([file('third.png')])
    await expect(page.locator('[data-testid^="describe-input-thumb-"]')).toHaveCount(2)

    const submit = page.getByTestId('describe-submit')
    await expect(submit).toHaveText('Analyze 2 images')
    await submit.click()

    await expect.poll(() => captured.describeJobs.length).toBe(2)
    const [a, b] = captured.describeJobs
    expect(a.image_id).not.toEqual(b.image_id)
    expect(a.prompt).toEqual(b.prompt)
    await expect(page.getByTestId('describe-job-detail')).toBeVisible()
  })
})
