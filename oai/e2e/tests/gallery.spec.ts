import { expect, test, type Page } from '@playwright/test'

/**
 * Gallery (/app/gallery): date-grouped grid, horizontally swipeable lightbox and
 * the prompt sheet. Fully mocked — no backend needed.
 */

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

const ago = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString()

function userFile(id: number, hoursAgo: number, prompt: string | null, direction = 'output') {
  return {
    id: String(id),
    kind: 'image',
    direction,
    source: prompt ? 'imggen' : 'upload',
    filename: `img-${id}.jpg`,
    content_type: 'image/jpeg',
    width: 1024,
    height: 1024,
    size_bytes: 1000,
    sha256: '',
    job_id: prompt ? String(id) : null,
    created_at: ago(hoursAgo),
    url: `/api/images/files/${id}`,
    thumbnail_url: `/api/images/files/${id}/thumbnail`,
    is_image: true,
    is_video: false,
    is_audio: false,
    is_starred: id === 2,
    ...(prompt
      ? {
          generation: {
            prompt,
            negative_prompt: id === 1 ? 'blurry, low quality' : null,
            capability: 'imggen.flux',
            workflow: 'txt2img',
            seed: 42,
          },
        }
      : {}),
  }
}

const FILES = [
  userFile(1, 1, 'a red fox in the snow'),
  userFile(2, 2, 'neon city at night'),
  userFile(3, 3, 'a quiet harbor at dawn'),
  userFile(4, 60, 'watercolor mountains'),
  userFile(5, 61, null, 'input'),
]

async function mockApi(page: Page): Promise<string[]> {
  const libraryQueries: string[] = []
  await page.addInitScript(() => localStorage.setItem('oai_token', 'test-token'))
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url())
    const { pathname } = url
    if (!pathname.startsWith('/api/')) return route.continue() // Vite's /src/api/*.ts modules
    const json = (body: unknown) => route.fulfill({ json: body })

    if (pathname === '/api/me') {
      return json({ id: 1, login: 'tester', google_id: null, created_at: ago(1000), used_storage_bytes: 0 })
    }
    if (pathname === '/api/files/images') {
      libraryQueries.push(url.search)
      const direction = url.searchParams.get('direction')
      const files = FILES.filter(f => !direction || direction === 'all' || f.direction === direction)
      return json({ files, has_more: false })
    }
    if (/^\/api\/images\/files\/\d+(\/thumbnail)?$/.test(pathname)) {
      return route.fulfill({ body: PNG, contentType: 'image/png' })
    }
    if (/\/starred$/.test(pathname)) return json({ starred: false })
    if (pathname === '/api/admin/am_i_admin') return json({ is_admin: false })
    if (pathname === '/api/progress/running') return json({ jobs: [] })
    return json({})
  })
  return libraryQueries
}

test.describe('Gallery', () => {
  test('lists generated images grouped by day', async ({ page }) => {
    const queries = await mockApi(page)
    await page.goto('/app/gallery')

    await expect(page.getByTestId('gallery-page')).toBeVisible()
    await expect(page.getByTestId('gallery-tile-1')).toBeVisible()
    await expect(page.getByTestId('gallery-tile-4')).toBeVisible()
    // Today and two-days-ago land in different sections.
    await expect(page.locator('[data-testid^="gallery-day-"]')).toHaveCount(2)
    expect(queries[0]).toContain('direction=output')

    await page.getByTestId('gallery-filter-uploads').click()
    await expect.poll(() => queries.some(q => q.includes('direction=input'))).toBe(true)
  })

  test('swipes between images and shows the prompt sheet on demand', async ({ page }) => {
    await mockApi(page)
    await page.goto('/app/gallery')
    await page.getByTestId('gallery-tile-2').click()

    const counter = page.getByTestId('image-lightbox-counter')
    await expect(counter).toHaveText('2 / 4')

    // Prompt sheet is closed until asked for.
    const sheet = page.getByTestId('image-lightbox-prompt')
    await expect(sheet).toHaveAttribute('aria-hidden', 'true')
    await page.getByTestId('image-lightbox-prompt-toggle').click()
    await expect(sheet).toHaveAttribute('aria-hidden', 'false')
    await expect(page.getByTestId('gallery-prompt-text')).toHaveText('neon city at night')

    // Arrow key moves one slide; the sheet stays open and follows the image.
    await page.keyboard.press('ArrowRight')
    await expect(counter).toHaveText('3 / 4')
    await expect(page.getByTestId('gallery-prompt-text')).toHaveText('a quiet harbor at dawn')

    // A real horizontal scroll (what a swipe does) changes the index too.
    await page.getByTestId('image-lightbox-track').evaluate(el => {
      el.scrollLeft = 0
    })
    await expect(counter).toHaveText('1 / 4')
    await expect(page.getByTestId('gallery-prompt-text')).toHaveText('a red fox in the snow')
    await expect(page.getByText('Negative · blurry, low quality')).toBeVisible()

    // `p` toggles the sheet closed again.
    await page.keyboard.press('p')
    await expect(sheet).toHaveAttribute('aria-hidden', 'true')
  })

  test('uploads show a no-prompt note', async ({ page }) => {
    await mockApi(page)
    await page.goto('/app/gallery')
    await page.getByTestId('gallery-filter-all').click()
    await page.getByTestId('gallery-tile-5').click()
    await page.getByTestId('image-lightbox-prompt-toggle').click()
    await expect(page.getByTestId('gallery-prompt-none')).toContainText('Uploaded image')
  })

  test('is usable on a phone-sized viewport', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await mockApi(page)
    await page.goto('/app/gallery')
    await expect(page.getByTestId('gallery-tile-1')).toBeVisible()
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )
    expect(overflow).toBe(0)

    await page.getByTestId('gallery-tile-1').click()
    await page.getByTestId('image-lightbox-prompt-toggle').click()
    await expect(page.getByTestId('gallery-prompt-text')).toBeVisible()
    // On touch widths the desktop arrows are hidden.
    await expect(page.getByTestId('image-lightbox-next')).toBeHidden()
  })
})
