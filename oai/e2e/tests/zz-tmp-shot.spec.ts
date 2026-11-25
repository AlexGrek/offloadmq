import { test } from '@playwright/test'
const now = '2026-11-21T12:00:00Z'
const c = (base: string, usage_count: number) => ({ base, raw: base, tags: [], online: true, last_available_at: now, usage_count })
for (const [name, size] of [['desktop', { width: 1280, height: 800 }], ['phone', { width: 360, height: 760 }]] as const) {
  test(`shots ${name}`, async ({ page }) => {
    await page.setViewportSize(size)
    await page.addInitScript(() => localStorage.setItem('oai_token', 't'))
    await page.route('**/api/**', route => {
      const path = new URL(route.request().url()).pathname
      if (!path.startsWith('/api/')) return route.continue()
      const json = (body: unknown) => route.fulfill({ json: body })
      if (path === '/api/me') return json({ id: 1, login: 'tester', created_at: now, used_storage_bytes: 0 })
      if (path === '/api/progress/running') return json({ jobs: [] })
      if (path === '/api/worlds/jobs') return json([])
      if (path === '/api/worlds/capabilities') return json({ capabilities: [c('world.splat', 7), c('world.pano360', 3), c('world.sharp', 0)] })
      if (path === '/api/images/capabilities') return json([c('imggen.paint', 1)].map(x => ({ ...x, tags: ['txt2img'] })))
      if (path === '/api/img-utils/capabilities') return json({ capabilities: ['seedvr2', 'restore', 'esrgan'].map(u => ({ base: `img-utils.${u}`, utility: u, workflows: ['upscale'], kind: 'comfy', online: u !== 'esrgan', last_available_at: new Date().toISOString(), upscale_usage: {} })) })
      if (path === '/api/prompt-placeholders') return json([])
      return route.fulfill({ status: 404 })
    })
    await page.goto('/app/worlds')
    await page.getByTestId('worlds-capability-trigger').click()
    await page.waitForTimeout(400)
    await page.screenshot({ path: `/tmp/worlds-${name}-generator.png` })
    await page.keyboard.press('Escape')
    await page.getByRole('heading', { name: 'VR Worlds' }).click()
    await page.getByTestId('worlds-generate-open').click()
    await page.getByTestId('worlds-image-upscale').check()
    await page.getByTestId('worlds-upscale-model-trigger').click()
    await page.waitForTimeout(400)
    await page.screenshot({ path: `/tmp/worlds-${name}-upscaler.png` })
  })
}
