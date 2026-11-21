import { expect, test } from '@playwright/test'

test('inline choices use independent draws and preserve existing placeholders', async ({ page }) => {
  await page.goto('/login')
  const results = await page.evaluate(async () => {
    const modulePath = '/src/lib/promptPlaceholders.ts'
    const { expandPromptPlaceholders, createPlaceholderUsage } = await import(modulePath)
    const originalRandom = Math.random
    try {
      const usage = createPlaceholderUsage()
      const defs = {
        scene: ['a {Red fox|Blue whale|Green bird}'],
        '.start': ['breathtaking shot of'],
        weapon: ['baseball bat'],
      }
      const results = []
      for (const random of [0, 0.5, 0.999999]) {
        Math.random = () => random
        results.push(expandPromptPlaceholders('{a|b|c} + {a|b|c}', usage))
        results.push(expandPromptPlaceholders('{scene}', usage, defs))
        results.push(expandPromptPlaceholders('{.start} woman with a {{animal}|{weapon}|{?}}', usage, defs))
      }
      results.push(expandPromptPlaceholders('{ Hat | }', usage))
      results.push(expandPromptPlaceholders('{é|é} / {same|same} / {|}', usage))
      results.push(expandPromptPlaceholders('{a|b {?} {unknown} {}', usage))
      return results
    } finally {
      Math.random = originalRandom
    }
  })
  expect(results[0]).toBe('a + a')
  expect(results[1]).toBe('a Red fox')
  expect(results[2]).toMatch(/^breathtaking shot of woman with a [^{}|]+$/)
  expect(results.slice(3)).toEqual([
    'b + b', 'a Blue whale', 'breathtaking shot of woman with a baseball bat',
    'c + c', 'a Green bird', 'breathtaking shot of woman with a {?}',
    '', 'é / same / ', '{a|b {?} {unknown} {}',
  ])
})

test('image submission expands choices while retaining the raw template', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('oai_token', 'test-token'))
  await page.route('**/api/**', route => {
    const { pathname } = new URL(route.request().url())
    if (!pathname.startsWith('/api/')) return route.continue()
    const json = (body: unknown) => route.fulfill({ json: body })
    if (pathname === '/api/me') return json({ id: 1, login: 'tester', created_at: '2026-11-13T12:00:00Z', used_storage_bytes: 0 })
    if (pathname === '/api/images/capabilities') return json([{ base: 'imggen.test', raw: 'imggen.test[txt2img]', tags: ['txt2img'], online: true, last_available_at: '2026-11-13T12:00:00Z', usage_count: 0 }])
    if (pathname === '/api/images/jobs' && route.request().method() === 'POST') {
      return route.fulfill({ status: 400, json: { error: 'Submission captured for test' } })
    }
    if (pathname === '/api/images/jobs' || pathname === '/api/prompt-placeholders') return json([])
    if (pathname === '/api/progress/running') return json({ jobs: [] })
    return route.fulfill({ status: 404, json: { error: 'Not mocked' } })
  })
  await page.goto('/app/images')
  const template = 'a {Red fox|Blue whale|Green bird} at {?}'
  await page.getByTestId('imggen-prompt').fill(template)
  const submitted = page.waitForRequest(request => request.url().endsWith('/api/images/jobs') && request.method() === 'POST')
  await page.getByTestId('imggen-submit-job').click()
  const body = (await submitted).postDataJSON()
  expect(body.prompt).toMatch(/^a (Red fox|Blue whale|Green bird) at \{\?\}$/)
  expect(body.prompt_template).toBe(template)
  await expect(page.getByTestId('imggen-prompt')).toHaveValue(template)
})

test('{random} expands into another placeholder', async ({ page }) => {
  await page.goto('/login')
  const results = await page.evaluate(async () => {
    const modulePath = '/src/lib/promptPlaceholders.ts'
    const { expandPromptPlaceholders, createPlaceholderUsage } = await import(modulePath)
    const originalRandom = Math.random
    try {
      // Pool: 7 builtin categories, then `?`, then non-empty custom names (`pet`).
      const defs = { pet: ['PET'], empty: [] }
      const results = []
      for (const random of [0.999999, 7.5 / 9]) {
        Math.random = () => random
        results.push(expandPromptPlaceholders('a {Random}', createPlaceholderUsage(), defs))
      }
      Math.random = () => 0
      results.push(expandPromptPlaceholders('{random}', createPlaceholderUsage(), defs))
      return results
    } finally {
      Math.random = originalRandom
    }
  })
  expect(results.slice(0, 2)).toEqual(['a PET', 'a {?}'])
  expect(results[2]).toMatch(/^[^{}]+$/)
})
