import { expect, test, type Page } from '@playwright/test'

/**
 * Img Model Wars: one prompt rendered by several imggen models. Fully mocked —
 * no backend needed.
 */

const now = '2026-11-06T12:00:00Z'

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

const cap = (base: string, tags: string[], online = true) => ({
  base,
  tags,
  raw: `${base}[${tags.join(';')}]`,
  online,
  last_available_at: now,
  usage_count: 0,
})

type War = { request: Record<string, unknown>; polls: number }

async function mockApi(page: Page) {
  const wars: War[] = []
  await page.addInitScript(() => localStorage.setItem('oai_token', 'test-token'))
  await page.route('**/api/**', async route => {
    const { pathname } = new URL(route.request().url())
    if (!pathname.startsWith('/api/')) return route.continue()
    const method = route.request().method()
    const json = (body: unknown, status = 200) => route.fulfill({ json: body, status })

    if (pathname === '/api/me') {
      return json({ id: 1, login: 'tester', google_id: null, created_at: now, used_storage_bytes: 0 })
    }
    if (pathname === '/api/images/capabilities') {
      return json([
        cap('imggen.flux', ['txt2img', 'img2img']),
        cap('imggen.sdxl', ['txt2img']),
        cap('imggen.wan', ['img2video']),
        cap('imggen.zimage', ['txt2img'], false),
      ])
    }
    if (pathname === '/api/prompt-placeholders') return json([])
    if (pathname.startsWith('/api/prompts/')) return json({ items: [], next_cursor: null })
    if (pathname.startsWith('/api/images/files/')) {
      return route.fulfill({ body: PNG, contentType: 'image/png' })
    }
    if (pathname === '/api/progress/running') return json({ jobs: [] })

    const view = (i: number) => {
      const war = wars[i]
      const done = war.polls > 1
      const models = war.request.models as string[]
      return {
        job_id: `war-${i + 1}`,
        status: done ? 'completed' : 'running',
        params: war.request,
        slots: models.map((model, k) => ({
          model,
          child_job_id: `img-${i}-${k}`,
          status: done ? 'completed' : 'running',
          stage: null,
          prompt: String(war.request.prompt).replace('{?}', `name ${k}`),
          error: null,
          output_image_id: done ? `${900 + k}` : null,
          output_width: done ? 1 : null,
          output_height: done ? 1 : null,
          submitted_at: now,
          started_at: now,
          typical_runtime_seconds: 30,
          execution_seconds: done ? 10 + k : null,
        })),
        error: null,
        created_at: now,
        updated_at: now,
      }
    }

    if (pathname === '/api/img-model-wars/jobs' && method === 'POST') {
      wars.push({ request: route.request().postDataJSON() as Record<string, unknown>, polls: 0 })
      return json({ job_id: `war-${wars.length}`, status: 'submitted' }, 201)
    }
    if (pathname === '/api/img-model-wars/jobs') return json(wars.map((_, i) => view(i)))
    const one = /^\/api\/img-model-wars\/jobs\/war-(\d+)$/.exec(pathname)
    if (one) {
      const i = Number(one[1]) - 1
      wars[i].polls++
      return json(view(i))
    }
    return json({})
  })
  return wars
}

test('renders the same expanded prompt with every selected model', async ({ page }) => {
  const wars = await mockApi(page)
  await page.goto('/app/img-model-wars')

  // Only txt2img models are offered; the two online ones are preselected.
  await expect(page.getByTestId('wars-model-imggen.flux')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('wars-model-imggen.sdxl')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('wars-model-imggen.zimage')).toHaveAttribute('aria-pressed', 'false')
  await expect(page.getByTestId('wars-model-imggen.wan')).toHaveCount(0)

  await page.getByTestId('wars-model-imggen.zimage').click()
  await expect(page.getByTestId('wars-models-count')).toHaveText('(3/8)')

  await page.getByTestId('wars-prompt').fill('a {color} {animal} named {?}')
  await page.getByTestId('wars-seed').fill('42')
  await page.getByTestId('wars-submit').click()

  await expect.poll(() => wars.length).toBe(1)
  const req = wars[0].request
  expect(req.models).toEqual(['imggen.flux', 'imggen.sdxl', 'imggen.zimage'])
  expect(req.prompt_template).toBe('a {color} {animal} named {?}')
  // Frontend placeholders are expanded once (shared by all models); {?} is left for the server.
  expect(req.prompt).not.toContain('{color}')
  expect(req.prompt).not.toContain('{animal}')
  expect(req.prompt).toContain('{?}')
  expect(req.seed).toBe(42)
  expect(req).toMatchObject({ width: 1024, height: 1024, override_negative: false })

  await expect(page).toHaveURL(/job=war-1/)
  await expect(page.getByTestId('wars-slots').locator('li')).toHaveCount(3)
  await expect(page.getByTestId('wars-status')).toHaveText(/completed/i, { timeout: 15_000 })
  await expect(page.getByTestId('wars-slot-image-imggen.sdxl')).toBeVisible()
  await expect(page.getByTestId('wars-slot-imggen.flux').getByTestId('wars-fastest')).toBeVisible()
  await expect(page.getByTestId('wars-fastest')).toHaveCount(1)

  // Edit loads the raw template back into the form.
  await page.getByTestId('wars-edit').click()
  await expect(page.getByTestId('wars-prompt')).toHaveValue('a {color} {animal} named {?}')
  await expect(page.getByTestId('wars-seed')).toHaveValue('42')
})

test('needs at least two models', async ({ page }) => {
  await mockApi(page)
  await page.goto('/app/img-model-wars')
  await page.getByTestId('wars-prompt').fill('a castle')
  await expect(page.getByTestId('wars-submit')).toBeEnabled()
  await page.getByTestId('wars-model-imggen.sdxl').click()
  await expect(page.getByTestId('wars-models-count')).toHaveText('(1/8)')
  await expect(page.getByTestId('wars-submit')).toBeDisabled()
})
