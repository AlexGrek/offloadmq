import { expect, test, type Page } from '@playwright/test'

// Fully mocked (no backend): Personas page — create, photo submit shape, persona-scoped chats.

const now = '2026-11-14T12:00:00Z'

type Persona = Record<string, unknown> & { id: string; name: string }

function persona(id: string, name: string, extra: Record<string, unknown> = {}): Persona {
  return {
    id,
    name,
    system_prompt: 'You are {p_name}.',
    rendered_system_prompt: `You are ${name}.`,
    look: 'red hair',
    face_image_ids: ['f1'],
    faces: [{ image_id: 'f1', filename: 'face.png', content_type: 'image/png', width: 64, height: 64 }],
    llm_capability: null,
    txt2img_capability: null,
    img2img_capability: null,
    face_swap_capability: null,
    upscaler_capability: null,
    created_at: now,
    updated_at: now,
    ...extra,
  }
}

async function mockApi(page: Page) {
  const state = {
    personas: [persona('p1', 'Ada')] as Persona[],
    created: [] as unknown[],
    photoStarts: [] as unknown[],
    chatQueries: [] as string[],
    chatCreates: [] as unknown[],
  }
  await page.addInitScript(() => localStorage.setItem('oai_token', 'test-token'))
  await page.routeWebSocket(/\/api\/ws\//, ws => {
    ws.send(JSON.stringify({ type: 'hello', user_id: '1' }))
    ws.onMessage(raw => {
      const msg = JSON.parse(String(raw))
      if (msg.type === 'list_capabilities') {
        ws.send(JSON.stringify({
          type: 'capabilities', req_id: msg.req_id,
          capabilities: [{ base: 'llm.fake', tags: [], raw: 'llm.fake', online: true, last_available_at: now }],
        }))
      }
    })
  })
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url())
    const { pathname } = url
    if (!pathname.startsWith('/api/')) return route.continue()
    const method = route.request().method()
    const json = (body: unknown, status = 200) => route.fulfill({ json: body, status })

    if (pathname === '/api/me') return json({ id: 1, login: 'tester', google_id: null, created_at: now, used_storage_bytes: 0 })
    if (pathname === '/api/progress/running') return json({ jobs: [] })
    if (pathname === '/api/personas/options') {
      return json({
        llm: [{ capability: 'llm.fake', online: true }],
        txt2img: [{ capability: 'imggen.flux', online: true }],
        img2img: [],
        face_swap: [{ capability: 'img-utils.reactor', workflow: 'face_swap', online: true }],
        upscaler: [{ capability: 'img-utils.seedvr2', workflow: 'upscale', online: true }],
        errors: [],
      })
    }
    if (pathname === '/api/personas' && method === 'GET') return json(state.personas)
    if (pathname === '/api/personas' && method === 'POST') {
      const body = route.request().postDataJSON()
      state.created.push(body)
      const p = persona('p2', body.name, { look: body.look, faces: [], face_image_ids: [] })
      state.personas = [p, ...state.personas]
      return json(p, 201)
    }
    const detail = /^\/api\/personas\/(\w+)$/.exec(pathname)
    if (detail && method === 'GET') {
      const p = state.personas.find(x => x.id === detail[1])
      return p
        ? json({ ...p, effective: { llm: { capability: 'llm.fake', source: 'only', online: true }, txt2img: null, img2img: null, face_swap: null, upscaler: null, errors: [] } })
        : json({ error: 'Not found' }, 404)
    }
    const photos = /^\/api\/personas\/(\w+)\/photos$/.exec(pathname)
    if (photos && method === 'GET') {
      const existing = (state.photoStarts[0] as { workflow?: string } | undefined)?.workflow === 'existing'
      return json(state.photoStarts.length ? [{
        job_id: 'j1', persona_id: photos[1], status: 'completed',
        prompt_template: existing ? '' : '{p_look}', prompt: existing ? '' : 'red hair',
        params: { workflow: existing ? 'existing' : 'txt2img', image_model: existing ? '' : 'imggen.flux', width: 1024, height: 1024, face_image_id: 'f1', scale: 2 },
        steps: (existing ? ['face_swap', 'upscale'] : ['generate', 'face_swap', 'upscale']).map(kind => ({ kind, status: 'completed', capability: 'x', workflow: kind, child_job_id: '1', input_image_id: null, output_image_id: 'out', stage: null, error: null })),
        final_image_id: 'out', final_image: null, error: null, created_at: now, updated_at: now,
      }] : [])
    }
    if (photos && method === 'POST') {
      state.photoStarts.push(route.request().postDataJSON())
      return json({ job_ids: ['j1'] }, 201)
    }
    if (pathname === '/api/chats' && method === 'GET') {
      state.chatQueries.push(url.search)
      return json([])
    }
    if (pathname === '/api/chats' && method === 'POST') {
      state.chatCreates.push(route.request().postDataJSON())
      return json({ id: 'c1', title: '', system_prompt: 'You are Ada.', last_model: null, kind: 'persona', persona_id: 'p1', created_at: now, updated_at: now }, 201)
    }
    if (pathname.startsWith('/api/images/files/')) {
      return route.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64') })
    }
    if (pathname.startsWith('/api/prompts/')) return json({ items: [], next_cursor: null })
    if (pathname === '/api/files/images') {
      return json({
        files: [{
          id: 'lib-1', kind: 'image', direction: 'output', source: 'image', filename: 'beach.jpg',
          content_type: 'image/jpeg', width: 1024, height: 768, size_bytes: 1000, sha256: '', job_id: null,
          created_at: now, url: '', thumbnail_url: '', is_image: true, is_video: false, is_audio: false, is_starred: false,
        }],
        has_more: false,
      })
    }
    return json({})
  })
  return state
}

test('opens the first persona, creates a new one', async ({ page }) => {
  const state = await mockApi(page)
  await page.goto('/app/personas')
  await expect(page).toHaveURL(/\/app\/personas\/p1\/profile/)
  await expect(page.getByTestId('persona-name')).toHaveValue('Ada')
  await expect(page.getByTestId('persona-faces')).toBeVisible()
  await expect(page.getByTestId('persona-model-llm')).toContainText('Auto — llm.fake (only one online)')

  await page.getByTestId('persona-new').click()
  await expect(page).toHaveURL(/\/app\/personas\/new/)
  await page.getByTestId('persona-name').fill('Bea')
  await page.getByTestId('persona-look').fill('short black hair')
  await page.getByTestId('persona-model-upscaler').selectOption('img-utils.seedvr2')
  await page.getByTestId('persona-save').click()
  await expect(page).toHaveURL(/\/app\/personas\/p2\/profile/)
  expect(state.created[0]).toMatchObject({ name: 'Bea', look: 'short black hair', upscaler_capability: 'img-utils.seedvr2', llm_capability: null })
})

test('photo defaults to txt2img → face swap → upscale ×2', async ({ page }) => {
  const state = await mockApi(page)
  await page.goto('/app/personas/p1/photos')
  await expect(page.getByTestId('persona-photos-empty')).toBeVisible()
  await page.getByTestId('persona-photo-prompt').fill('{p_look}, portrait of {p_name}')
  await page.getByTestId('persona-photo-submit').click()
  await expect(page.getByTestId('persona-photo-j1')).toBeVisible()
  expect(state.photoStarts[0]).toMatchObject({
    prompt: '{p_look}, portrait of {p_name}', workflow: 'txt2img', face_swap: true, upscale: true, scale: 2, count: 1,
  })
  await expect(page.getByTestId('persona-photo-steps-j1')).toContainText('Face swap')
})

test('existing photo: face swap + upscale, no prompt or generation', async ({ page }) => {
  const state = await mockApi(page)
  await page.goto('/app/personas/p1/photos')
  await page.getByTestId('persona-photo-workflow-existing').click()
  await expect(page.getByTestId('persona-photo-prompt')).toHaveCount(0)
  await expect(page.getByTestId('persona-photo-count')).toHaveCount(0)
  await expect(page.getByTestId('persona-photo-faceswap')).toBeChecked()
  await expect(page.getByTestId('persona-photo-faceswap')).toBeDisabled()
  const submit = page.getByTestId('persona-photo-submit')
  await expect(submit).toBeDisabled() // no photo picked yet
  await expect(submit).toHaveText(/Swap face/)

  await page.getByTestId('persona-photo-input').click()
  await page.getByTestId('imggen-picker-file-lib-1').click()
  await page.getByTestId('imggen-picker-confirm').click()
  await page.getByTestId('persona-photo-upscale').uncheck()
  await submit.click()
  await expect(page.getByTestId('persona-photo-j1')).toBeVisible()
  expect(state.photoStarts[0]).toEqual({ workflow: 'existing', input_image_id: 'lib-1', upscale: false, scale: 2 })
  await expect(page.getByTestId('persona-photo-steps-j1')).not.toContainText('Generate')
  await expect(page.getByTestId('persona-photo-j1')).toContainText('From an existing photo')
})

test('chat tab lists only this persona’s chats and starts one on send', async ({ page }) => {
  const state = await mockApi(page)
  await page.goto('/app/personas/p1/chat')
  await expect(page.getByTestId('persona-chat-empty')).toContainText('You are Ada.')
  expect(state.chatQueries).toContain('?kind=persona&persona_id=p1')
  await page.getByTestId('chat-input').fill('hello')
  await page.getByTestId('send-btn').click()
  await expect.poll(() => state.chatCreates.length).toBe(1)
  expect(state.chatCreates[0]).toMatchObject({ kind: 'persona', persona_id: 'p1' })
})

test('photo opens in the shared lightbox with tools and scrolls between photos', async ({ page }) => {
  await mockApi(page)
  const mk = (id: string, img: string, prompt: string) => ({
    job_id: id, persona_id: 'p1', status: 'completed', prompt_template: prompt, prompt,
    params: { workflow: 'txt2img', image_model: 'imggen.flux', width: 1024, height: 1024, face_image_id: 'f1', scale: 2 },
    steps: [], final_image_id: img, final_image: null, error: null,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  })
  // Registered last → wins over the mockApi handler.
  await page.route('**/api/personas/p1/photos', route =>
    route.request().method() === 'GET'
      ? route.fulfill({ json: [mk('j2', 'img-b', 'second'), mk('j1', 'img-a', 'first')] })
      : route.fallback(),
  )
  await page.goto('/app/personas/p1/photos')
  await page.getByTestId('persona-photo-open-j2').click()

  const track = page.getByTestId('image-lightbox-track')
  await expect(track).toBeVisible()
  await expect(page.getByTestId('image-lightbox-counter')).toHaveText('1 / 2')
  const actions = page.getByTestId('image-lightbox-actions')
  await expect(actions.getByTestId('image-lightbox-imgutils')).toBeVisible()
  await expect(actions.getByTestId('image-lightbox-edit')).toBeVisible()
  await expect(actions.getByTestId('image-lightbox-star')).toBeVisible()
  // Deleting the image alone would orphan the run — that stays on the card.
  await expect(actions.getByTestId('image-lightbox-delete')).toHaveCount(0)

  await page.keyboard.press('ArrowRight')
  await expect(page.getByTestId('image-lightbox-counter')).toHaveText('2 / 2')
  await page.keyboard.press('ArrowLeft')
  await expect(page.getByTestId('image-lightbox-counter')).toHaveText('1 / 2')
})
