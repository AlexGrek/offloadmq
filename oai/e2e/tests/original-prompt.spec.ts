import { expect, test, type Page } from '@playwright/test'

/**
 * Original (unsubstituted) prompt: jobs and library files keep the prompt as typed
 * (`prompt_template`) next to the substituted one. "Edit original" restores it
 * with placeholders intact; "Edit prompt" restores the prompt the model got.
 * Older jobs without a template show no "Edit original". Fully mocked.
 */

const now = '2026-11-21T12:00:00Z'
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

function job(id: string, prompt: string, template: string | null) {
  return {
    job_id: id,
    display_name: id,
    status: 'completed',
    prompt,
    // Older jobs predate the field entirely.
    ...(template !== null ? { prompt_template: template } : {}),
    negative_prompt: null,
    capability: 'imggen.flux',
    workflow: 'txt2img',
    width: 1024,
    height: 1024,
    seed: 7,
    input_image_id: null,
    pipeline_params: {
      capability: 'imggen.flux',
      prompt,
      override_negative: false,
      width: 1024,
      height: 1024,
      seed: 7,
      workflow: 'txt2img',
      ...(template !== null ? { prompt_template: template } : {}),
    },
    error: null,
    offload_cap: null,
    offload_task_id: null,
    files: [],
    events: [],
  }
}

const JOBS = [
  job('job-new', 'a red fox in the snow', 'a {color} fox in the snow'),
  job('job-old', 'a blue owl', null),
  job('job-plain', 'a quiet harbor', 'a quiet harbor'),
]

function libraryFile(id: number, prompt: string, template: string | null) {
  return {
    id: String(id),
    kind: 'image',
    direction: 'output',
    source: 'imggen',
    filename: `img-${id}.jpg`,
    content_type: 'image/jpeg',
    width: 1024,
    height: 1024,
    size_bytes: 1000,
    sha256: '',
    job_id: String(id),
    created_at: now,
    url: `/api/images/files/${id}`,
    thumbnail_url: `/api/images/files/${id}/thumbnail`,
    is_image: true,
    is_video: false,
    is_audio: false,
    is_starred: false,
    generation: {
      prompt,
      ...(template !== null ? { prompt_template: template } : {}),
      negative_prompt: null,
      capability: 'imggen.flux',
      workflow: 'txt2img',
      seed: 42,
    },
  }
}

const FILES = [
  libraryFile(1, 'a green {?} dragon', 'a {color} {?} dragon'),
  libraryFile(2, 'an old lighthouse', null),
]

async function mockApi(page: Page) {
  await page.addInitScript(() => localStorage.setItem('oai_token', 'test-token'))
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url())
    const { pathname } = url
    if (!pathname.startsWith('/api/')) return route.continue()
    const method = route.request().method()
    const json = (body: unknown) => route.fulfill({ json: body })

    if (pathname === '/api/admin/am_i_admin') return json({ is_admin: false })
    if (pathname === '/api/me') {
      return json({ id: 1, login: 'tester', google_id: null, created_at: now, used_storage_bytes: 0 })
    }
    if (pathname === '/api/images/external-resize') return json({ available: false, threshold_bytes: 0 })
    if (pathname === '/api/images/capabilities') {
      return json([
        { base: 'imggen.flux', tags: ['txt2img'], raw: 'imggen.flux[txt2img]', online: true, last_available_at: now, usage_count: 0 },
      ])
    }
    if (pathname === '/api/images/jobs' && method === 'GET') return json(JOBS)
    const one = /^\/api\/images\/jobs\/([\w-]+)$/.exec(pathname)
    if (one) {
      const found = JOBS.find(j => j.job_id === one[1])
      return found ? json(found) : route.fulfill({ status: 404, json: { error: 'not found' } })
    }
    if (pathname === '/api/files/images') return json({ files: FILES, has_more: false })
    if (/^\/api\/images\/files\/\d+(\/thumbnail)?$/.test(pathname)) {
      return route.fulfill({ body: PNG, contentType: 'image/png' })
    }
    if (pathname === '/api/progress/running') return json({ jobs: [] })
    if (pathname.startsWith('/api/prompts/')) return json({})
    if (pathname === '/api/prompt-placeholders') return json([])
    return route.fulfill({ status: 404, json: { error: 'Not mocked' } })
  })
}

test.describe('original prompt', () => {
  test('image job: Edit original restores the template, Edit prompt the substituted text', async ({ page }) => {
    await mockApi(page)
    await page.goto('/app/images')

    await page.getByTestId('imggen-pipeline-item-job-new').click()
    await expect(page.getByTestId('imggen-job-original-prompt')).toHaveText('Original: a {color} fox in the snow')
    await page.getByTestId('imggen-edit-original').click()
    await expect(page.getByTestId('imggen-prompt')).toHaveValue('a {color} fox in the snow')

    await page.getByTestId('imggen-pipeline-item-job-new').click()
    await page.getByTestId('imggen-edit-prompt').click()
    await expect(page.getByTestId('imggen-prompt')).toHaveValue('a red fox in the snow')
  })

  test('image job: no Edit original for older jobs or when nothing was substituted', async ({ page }) => {
    await mockApi(page)
    await page.goto('/app/images')

    await page.getByTestId('imggen-pipeline-item-job-old').click()
    await expect(page.getByTestId('imggen-edit-prompt')).toBeVisible()
    await expect(page.getByTestId('imggen-edit-original')).toHaveCount(0)
    await expect(page.getByTestId('imggen-job-original-prompt')).toHaveCount(0)

    await page.getByTestId('imggen-pipeline-item-job-plain').click()
    await expect(page.getByTestId('imggen-edit-prompt')).toBeVisible()
    await expect(page.getByTestId('imggen-edit-original')).toHaveCount(0)
  })

  test('gallery: prompt sheet offers the original only when one is stored', async ({ page }) => {
    await mockApi(page)
    await page.goto('/app/gallery')

    await page.getByTestId('gallery-tile-1').click()
    await page.keyboard.press('p')
    await expect(page.getByTestId('gallery-prompt-original')).toContainText('a {color} {?} dragon')
    await page.getByTestId('gallery-prompt-use-original').click()
    await expect(page).toHaveURL(/\/app\/images/)
    await expect(page.getByTestId('imggen-prompt')).toHaveValue('a {color} {?} dragon')
  })

  test('gallery: older files show no original', async ({ page }) => {
    await mockApi(page)
    await page.goto('/app/gallery')

    await page.getByTestId('gallery-tile-2').click()
    await page.keyboard.press('p')
    await expect(page.getByTestId('gallery-prompt-text')).toHaveText('an old lighthouse')
    await expect(page.getByTestId('gallery-prompt-original')).toHaveCount(0)
  })
})
