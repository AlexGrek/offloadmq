import { expect, test, type Page } from '@playwright/test'

/**
 * Image Tools: several target images (drop / pick / paste) → one job per image,
 * sharing the tool and the face reference. Fully mocked — no backend needed.
 */

const now = '2026-11-08T12:00:00Z'
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const PNG = Buffer.from(PNG_B64, 'base64')
const file = (name: string) => ({ name, mimeType: 'image/png', buffer: PNG })

type Captured = { uploads: string[]; starts: Record<string, unknown>[] }

async function mockApi(page: Page, opts: { failStartAt?: number } = {}): Promise<Captured> {
  const captured: Captured = { uploads: [], starts: [] }
  let nextImage = 100
  await page.addInitScript(() => localStorage.setItem('oai_token', 'test-token'))
  await page.route('**/api/**', async route => {
    const { pathname } = new URL(route.request().url())
    if (!pathname.startsWith('/api/')) return route.continue()
    const method = route.request().method()
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body })
    if (pathname === '/api/admin/am_i_admin') return json({ is_admin: false })
    if (pathname === '/api/me') return json({ id: 1, login: 'tester', google_id: null, created_at: now, used_storage_bytes: 0 })
    if (pathname === '/api/progress/running') return json({ jobs: [] })
    if (pathname === '/api/img-utils/capabilities') {
      return json({
        capabilities: [{
          base: 'img-utils.lotus', utility: 'lotus', workflows: ['depth'], raw: 'img-utils.lotus[depth]',
          needs_source_image: false, kind: 'comfy', methods: [],
        }],
      })
    }
    if (pathname === '/api/images/upload' && method === 'POST') {
      const body = route.request().postDataBuffer()?.toString('latin1') ?? ''
      const filename = /filename="([^"]+)"/.exec(body)?.[1] ?? 'unknown.png'
      captured.uploads.push(filename)
      return json({ image_id: String(nextImage++), filename, content_type: 'image/png', width: 1, height: 1, size_bytes: 68, rescaled: false, reencoded: false })
    }
    if (pathname === '/api/img-utils/jobs' && method === 'POST') {
      if (opts.failStartAt === captured.starts.length) return json({ error: 'agent offline' }, 500)
      captured.starts.push(route.request().postDataJSON())
      return json({ job_id: `job-${captured.starts.length}`, status: 'submitted' }, 201)
    }
    if (pathname === '/api/img-utils/jobs' && method === 'GET') {
      return json(captured.starts.map((_, i) => jobView(i + 1)).reverse())
    }
    const job = /^\/api\/img-utils\/jobs\/job-(\d+)(\/poll)?$/.exec(pathname)
    if (job) return json(jobView(Number(job[1])))
    if (pathname.startsWith('/api/images/files/')) return route.fulfill({ status: 200, contentType: 'image/png', body: PNG })
    return json({})
  })
  return captured
}

function jobView(n: number) {
  return {
    job_id: `job-${n}`, status: 'running', capability: 'img-utils.lotus', workflow: 'depth', kind: 'comfy',
    input_image_id: '100', source_image_id: null, output_image_id: null, options: {},
    input_image: null, source_image: null, output_image: null, error: null, stage: null,
    created_at: now, updated_at: now,
  }
}

async function pasteImages(page: Page, names: string[], text = '') {
  await page.evaluate(
    ([fileNames, b64, t]) => {
      const png = Uint8Array.from(atob(b64), c => c.charCodeAt(0))
      const dt = new DataTransfer()
      for (const name of fileNames) dt.items.add(new File([png], name, { type: 'image/png' }))
      if (t) dt.setData('text/plain', t)
      document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
    },
    [names, PNG_B64, text] as const,
  )
}

test('several images → one job each; the form is emptied', async ({ page }) => {
  const captured = await mockApi(page)
  await page.goto('/app/img-utils')

  await page.getByTestId('imgutils-input-file-input').setInputFiles([file('a.png'), file('b.png')])
  await expect(page.getByTestId('imgutils-input-thumb')).toHaveCount(2)

  const run = page.getByTestId('imgutils-submit')
  await expect(run).toContainText('on 2 images')
  await expect(run).toBeEnabled()
  await run.click()

  await expect.poll(() => captured.starts.length).toBe(2)
  const [a, b] = captured.starts
  expect(a.input_image_id).not.toEqual(b.input_image_id)
  expect(a).toMatchObject({ capability: 'img-utils.lotus', workflow: 'depth' })
  expect(b).toMatchObject({ capability: 'img-utils.lotus', workflow: 'depth' })
  await expect(page.getByTestId('imgutils-job-detail')).toBeVisible()
})

test('pasted images are added as targets; text pastes are left alone', async ({ page }) => {
  const captured = await mockApi(page)
  await page.goto('/app/img-utils')
  await expect(page.getByTestId('imgutils-input-drop-zone')).toBeVisible()

  await pasteImages(page, ['x.png'], 'copied words')
  await page.waitForTimeout(300)
  expect(captured.uploads).toEqual([])

  await pasteImages(page, ['one.png', 'two.png'])
  await expect(page.getByTestId('imgutils-input-thumb')).toHaveCount(2)
  await pasteImages(page, ['three.png'])
  await expect(page.getByTestId('imgutils-input-thumb')).toHaveCount(3)
  expect(captured.uploads).toHaveLength(3)

  await page.getByTestId('imgutils-input-remove').first().click()
  await expect(page.getByTestId('imgutils-input-thumb')).toHaveCount(2)
  await expect(page.getByTestId('imgutils-submit')).toContainText('on 2 images')
})

test('a failing job keeps only the images that did not go through', async ({ page }) => {
  const captured = await mockApi(page, { failStartAt: 1 })
  await page.goto('/app/img-utils')
  await page.getByTestId('imgutils-input-file-input').setInputFiles([file('a.png'), file('b.png'), file('c.png')])
  await expect(page.getByTestId('imgutils-input-thumb')).toHaveCount(3)

  await page.getByTestId('imgutils-submit').click()
  await expect(page.getByTestId('imgutils-error')).toContainText('Submitted 1 of 3 jobs')
  expect(captured.starts).toHaveLength(1)
  // The accepted image left the set; the other two are still there to retry.
  await expect(page.getByTestId('imgutils-input-thumb')).toHaveCount(2)
  await expect(page.getByTestId('imgutils-new-panel')).toBeVisible()
})

test('no paste handling while viewing a job', async ({ page }) => {
  const captured = await mockApi(page)
  await page.goto('/app/img-utils')
  await page.getByTestId('imgutils-input-file-input').setInputFiles([file('a.png')])
  await expect(page.getByTestId('imgutils-input-thumb')).toHaveCount(1)
  await page.getByTestId('imgutils-submit').click()
  await expect(page.getByTestId('imgutils-job-detail')).toBeVisible()

  const before = captured.uploads.length
  await pasteImages(page, ['late.png'])
  await page.waitForTimeout(300)
  expect(captured.uploads.length).toBe(before)
})
