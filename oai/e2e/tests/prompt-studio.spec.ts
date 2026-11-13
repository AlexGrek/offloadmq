import { expect, test, type Page } from '@playwright/test'

/**
 * Prompt Studio (`/app/prompt-studio`): Enter adds a newline, Ctrl/⌘+Enter sends,
 * the example prompt is rendered through the message template into the composer,
 * the first send creates a `kind: prompt_studio` chat, replies offer "Use as prompt"
 * and the "another one" quick reply, and Image Generation / Describe Image open the
 * studio with their prompt. Fully mocked — no backend needed.
 */

const now = '2026-11-13T12:00:00Z'
const TEMPLATE = 'Here is the prompt example, generate something similar: {prompt}'
const REPLY_PROMPT = 'A neon fox in a rainy alley, cinematic rim light'

type Captured = {
  createdChats: Record<string, unknown>[]
  wsChats: { content: string; chat_id: string }[]
  recentPrompts: { bucket: string; content: string }[]
  imageJobs: Record<string, unknown>[]
}

const defaultReply = (n: number) => '```\n' + REPLY_PROMPT + (n > 1 ? ` #${n}` : '') + '\n```'

async function mockApi(page: Page, reply: (n: number) => string = defaultReply): Promise<Captured> {
  const captured: Captured = { createdChats: [], wsChats: [], recentPrompts: [], imageJobs: [] }

  await page.addInitScript(() => localStorage.setItem('oai_token', 'test-token'))
  await page.routeWebSocket(/\/api\/ws\/chat/, ws => {
    ws.send(JSON.stringify({ type: 'hello', user_id: '1' }))
    ws.onMessage(raw => {
      const msg = JSON.parse(String(raw))
      if (msg.type === 'list_capabilities') {
        ws.send(JSON.stringify({
          type: 'capabilities',
          req_id: msg.req_id,
          capabilities: [
            { base: 'llm.artist', tags: ['vision'], raw: 'llm.artist[vision]', online: true, last_available_at: now, usage_count: 1 },
          ],
        }))
      }
      if (msg.type === 'chat') {
        captured.wsChats.push({ content: msg.content, chat_id: msg.chat_id })
        const n = captured.wsChats.length
        ws.send(JSON.stringify({ type: 'task:queued', req_id: msg.req_id, cap: 'llm.artist', id: `t${n}` }))
        ws.send(JSON.stringify({ type: 'task:result', req_id: msg.req_id, text: reply(n) }))
      }
    })
  })

  await page.route('**/api/**', async route => {
    const { pathname, searchParams } = new URL(route.request().url())
    if (!pathname.startsWith('/api/')) return route.continue()
    const method = route.request().method()
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body })

    if (pathname === '/api/me') {
      return json({ id: 1, login: 'tester', google_id: null, created_at: now, used_storage_bytes: 0 })
    }
    if (pathname === '/api/admin/am_i_admin') return json({ is_admin: false })
    if (pathname === '/api/chats' && method === 'GET') {
      expect(searchParams.get('kind')).toBe('prompt_studio')
      return json([])
    }
    if (pathname === '/api/chats' && method === 'POST') {
      const body = route.request().postDataJSON() as Record<string, unknown>
      captured.createdChats.push(body)
      return json({
        id: 'studio-1',
        title: '',
        system_prompt: body.system_prompt ?? 'default',
        last_model: body.last_model ?? null,
        kind: body.kind,
        created_at: now,
        updated_at: now,
      }, 201)
    }
    if (/^\/api\/chats\/[^/]+\/messages$/.test(pathname)) return json([])
    const recent = /^\/api\/prompts\/([^/]+)\/recent$/.exec(pathname)
    if (recent && method === 'POST') {
      const { content } = route.request().postDataJSON() as { content: string }
      captured.recentPrompts.push({ bucket: recent[1], content })
      return json({ id: 'p1', content })
    }
    if (pathname.startsWith('/api/prompts/')) return json({ items: [], next_cursor: null })

    // Image Generation (target of "Use as prompt", source of the studio button).
    if (pathname === '/api/images/external-resize') return json({ available: false, threshold_bytes: 0 })
    if (pathname === '/api/images/capabilities') {
      return json([
        { base: 'imggen.flux', tags: ['txt2img'], raw: 'imggen.flux[txt2img]', online: true, last_available_at: now, usage_count: 0 },
      ])
    }
    if (pathname === '/api/images/jobs' && method === 'GET') return json([])
    if (pathname === '/api/images/jobs' && method === 'POST') {
      captured.imageJobs.push(route.request().postDataJSON() as Record<string, unknown>)
      return json({ job_id: `image-${captured.imageJobs.length}`, status: 'submitted' })
    }
    if (pathname === '/api/images/stash') return json([])
    if (pathname === '/api/prompt-placeholders') return json([])
    if (pathname === '/api/progress/running') return json({ jobs: [] })
    return json({ error: 'Not mocked' }, 404)
  })
  return captured
}

test('Enter adds a newline; Ctrl+Enter sends and creates a prompt_studio session', async ({ page }) => {
  const captured = await mockApi(page)
  await page.goto('/app/prompt-studio')
  await expect(page.getByTestId('prompt-studio-setup')).toBeVisible()

  const input = page.getByTestId('chat-input')
  await expect(input).toBeEnabled()
  await input.fill('first line')
  await expect(page.getByTestId('send-btn')).toBeEnabled()
  await input.press('Enter')
  await input.pressSequentially('second line')
  await expect(input).toHaveValue('first line\nsecond line')
  expect(captured.wsChats).toHaveLength(0)

  await input.press('Control+Enter')
  await expect.poll(() => captured.wsChats.length).toBe(1)
  expect(captured.wsChats[0]).toEqual({ content: 'first line\nsecond line', chat_id: 'studio-1' })
  expect(captured.createdChats[0]).toMatchObject({ kind: 'prompt_studio', last_model: 'llm.artist' })
  expect(String(captured.createdChats[0].system_prompt)).toContain('prompt engineer')
  await expect(input).toHaveValue('')
  // Freeform first message — no template was used, so none is recorded.
  expect(captured.recentPrompts.filter(p => p.bucket === 'prompt-studio-user')).toHaveLength(0)
})

test('example prompt fills the template; replies offer another-one and Use as prompt', async ({ page }) => {
  const captured = await mockApi(page)
  await page.goto('/app/prompt-studio')

  await page.getByTestId('prompt-studio-example').fill('a red fox at dawn')
  const input = page.getByTestId('chat-input')
  const rendered = TEMPLATE.replace('{prompt}', 'a red fox at dawn')
  await expect(input).toHaveValue(rendered)

  // Editing the template re-renders while the composer still holds the rendered text.
  await page.getByTestId('prompt-studio-template').fill('Riff on: {prompt}')
  await expect(input).toHaveValue('Riff on: a red fox at dawn')
  // A user edit is never clobbered by later example changes.
  await input.fill('my own words')
  await page.getByTestId('prompt-studio-example').fill('a blue fox')
  await expect(input).toHaveValue('my own words')
  await input.fill('')
  await page.getByTestId('prompt-studio-example').fill('a red fox at dawn')
  await expect(input).toHaveValue('Riff on: a red fox at dawn')

  await page.getByTestId('send-btn').click()
  await expect.poll(() => captured.wsChats.length).toBe(1)
  expect(captured.wsChats[0].content).toBe('Riff on: a red fox at dawn')
  await expect
    .poll(() => captured.recentPrompts)
    .toContainEqual({ bucket: 'prompt-studio-user', content: 'Riff on: {prompt}' })

  await expect(page.getByTestId('prompt-studio-use-as-prompt')).toHaveCount(1)
  await page.getByTestId('prompt-studio-another').click()
  await expect.poll(() => captured.wsChats.length).toBe(2)
  expect(captured.wsChats[1]).toEqual({ content: 'Good, now create another one', chat_id: 'studio-1' })
  await expect(page.getByTestId('prompt-studio-use-as-prompt')).toHaveCount(2)

  await page.getByTestId('prompt-studio-use-as-prompt').last().click()
  await expect(page).toHaveURL(/\/app\/images$/)
  await expect(page.getByTestId('imggen-prompt')).toHaveValue(`${REPLY_PROMPT} #2`)
})

test('Image Generation opens Prompt Studio with its prompt as the example', async ({ page }) => {
  await mockApi(page)
  await page.goto('/app/images')
  await page.getByTestId('imggen-prompt').fill('a castle made of glass')
  await page.getByTestId('imggen-prompt-studio-open').click()

  await expect(page).toHaveURL(/\/app\/prompt-studio$/)
  await expect(page.getByTestId('prompt-studio-example')).toHaveValue('a castle made of glass')
  await expect(page.getByTestId('chat-input')).toHaveValue(
    TEMPLATE.replace('{prompt}', 'a castle made of glass'),
  )
})

test('Describe Image opens Prompt Studio with the description as the example', async ({ page }) => {
  await mockApi(page)
  const description = 'A lighthouse on a cliff during a violet storm.'
  const job = {
    job_id: 'describe-1',
    status: 'completed',
    prompt: 'Describe this image',
    capability: 'llm.vision',
    input_image_id: null,
    result: description,
    stage: null,
    error: null,
    offload_cap: null,
    offload_task_id: null,
    created_at: now,
    updated_at: now,
  }
  await page.route('**/api/describe/**', route => {
    const { pathname } = new URL(route.request().url())
    if (pathname === '/api/describe/jobs') return route.fulfill({ json: [job] })
    if (pathname === '/api/describe/jobs/describe-1') return route.fulfill({ json: job })
    if (pathname === '/api/describe/capabilities') return route.fulfill({ json: { capabilities: [] } })
    return route.fulfill({ status: 404, json: { error: 'Not mocked' } })
  })

  await page.goto('/app/describe')
  await page.getByTestId('describe-item-describe-1').click()
  await page.getByTestId('describe-prompt-studio-open').click()

  await expect(page).toHaveURL(/\/app\/prompt-studio$/)
  await expect(page.getByTestId('prompt-studio-example')).toHaveValue(description)
  await expect(page.getByTestId('chat-input')).toHaveValue(TEMPLATE.replace('{prompt}', description))
})

async function startSession(page: Page, captured: Captured) {
  await page.goto('/app/prompt-studio')
  await page.getByTestId('chat-input').fill('Give me a prompt')
  await page.getByTestId('send-btn').click()
  await expect.poll(() => captured.wsChats.length).toBe(1)
}

test('every reply has Generate / Edit / Use; Generate opens the quick dialog without focusing the prompt', async ({ page }) => {
  const captured = await mockApi(page)
  await startSession(page, captured)

  await expect(page.getByTestId('prompt-studio-generate')).toBeVisible()
  await expect(page.getByTestId('prompt-studio-edit')).toBeVisible()
  await expect(page.getByTestId('prompt-studio-use-as-prompt')).toBeVisible()
  // The user's own message gets the same three actions.
  await expect(page.getByTestId('prompt-studio-user-generate')).toBeVisible()

  await page.getByTestId('prompt-studio-generate').click()
  await expect(page.getByTestId('prompt-studio-generate-dialog')).toBeVisible()
  const promptField = page.getByTestId('prompt-studio-generate-prompt')
  await expect(promptField).toHaveValue(REPLY_PROMPT)
  await expect(promptField).not.toBeFocused()
  await expect(page.getByTestId('prompt-studio-generate-model')).toHaveValue('imggen.flux')
  await page.getByTestId('prompt-studio-generate-size-1280x720').click()
  await page.getByTestId('prompt-studio-generate-submit').click()

  await expect.poll(() => captured.imageJobs.length).toBe(1)
  expect(captured.imageJobs[0]).toMatchObject({
    capability: 'imggen.flux',
    prompt: REPLY_PROMPT,
    width: 1280,
    height: 720,
    workflow: 'txt2img',
  })
  await expect(page.getByTestId('prompt-studio-generate-dialog')).toBeHidden()
  await expect(page).toHaveURL(/\/app\/prompt-studio$/)
})

test('prompt editor: highlight, delete and edit sentences, then generate at a picked size', async ({ page }) => {
  const reply = 'A lone lighthouse on a cliff. Violet storm clouds swirl above. Shot on 35mm film.'
  const captured = await mockApi(page, () => reply)
  await startSession(page, captured)

  await page.getByTestId('prompt-studio-edit').click()
  const editor = page.getByTestId('prompt-editor')
  await expect(editor).toBeVisible()
  await expect(editor.locator('[data-segment]')).toHaveCount(3)
  await expect(page.getByTestId('prompt-editor-segment-1')).toHaveText('Violet storm clouds swirl above.')

  // Click selects (toolbar appears), Delete removes the sentence.
  await page.getByTestId('prompt-editor-segment-1').click()
  await expect(page.getByTestId('prompt-editor-segment-1')).toHaveAttribute('aria-pressed', 'true')
  await page.getByTestId('prompt-editor-segment-delete').click()
  await expect(editor.locator('[data-segment]')).toHaveCount(2)
  await expect(page.getByTestId('prompt-editor-segment-1')).toHaveText('Shot on 35mm film.')
  // The next sentence is selected, so Delete can be pressed repeatedly.
  await expect(page.getByTestId('prompt-editor-segment-1')).toHaveAttribute('aria-pressed', 'true')

  // Undo brings it back; redo removes it again.
  await page.getByTestId('prompt-editor-undo').click()
  await expect(editor.locator('[data-segment]')).toHaveCount(3)
  await page.getByTestId('prompt-editor-redo').click()
  await expect(editor.locator('[data-segment]')).toHaveCount(2)

  // Edit in place: select, Edit, type, Enter.
  await page.getByTestId('prompt-editor-segment-0').click()
  await page.getByTestId('prompt-editor-segment-edit').click()
  const input = page.getByTestId('prompt-editor-segment-input')
  await expect(input).toBeFocused()
  await input.fill('A lone lighthouse on a basalt cliff at dusk.')
  await input.press('Enter')
  await expect(page.getByTestId('prompt-editor-segment-0')).toHaveText('A lone lighthouse on a basalt cliff at dusk.')

  // Add a sentence at the end.
  await page.getByTestId('prompt-editor-add').click()
  await page.getByTestId('prompt-editor-segment-input').fill('Heavy grain')
  await page.getByTestId('prompt-editor-segment-save').click()
  const edited = 'A lone lighthouse on a basalt cliff at dusk. Shot on 35mm film. Heavy grain'
  await expect(editor.locator('[data-segment]')).toHaveText([
    'A lone lighthouse on a basalt cliff at dusk.',
    'Shot on 35mm film.',
    'Heavy grain',
  ])

  // Phrase mode splits on commas too.
  await page.getByTestId('prompt-editor-mode-phrase').click()
  await expect(page.getByTestId('prompt-editor-stats')).toContainText('3 phrases')
  await page.getByTestId('prompt-editor-mode-sentence').click()

  // Pick a size and generate right away; the editor stays open.
  await page.getByTestId('prompt-editor-size-768x1024').click()
  await expect(page.getByTestId('prompt-editor-model')).toHaveValue('imggen.flux')
  await page.getByTestId('prompt-editor-generate').click()
  await expect.poll(() => captured.imageJobs.length).toBe(1)
  expect(captured.imageJobs[0]).toMatchObject({ prompt: edited, width: 768, height: 1024, workflow: 'txt2img' })
  await expect(page.getByTestId('prompt-editor-notice')).toContainText('Started 1 image')
  await expect(editor).toBeVisible()

  // Use hands the edited prompt to Image Generation.
  await page.getByTestId('prompt-editor-use').click()
  await expect(page).toHaveURL(/\/app\/images$/)
  await expect(page.getByTestId('imggen-prompt')).toHaveValue(edited)
})

test('example prompt can be edited in the prompt editor and applied back', async ({ page }) => {
  await mockApi(page)
  await page.goto('/app/prompt-studio')
  await expect(page.getByTestId('prompt-studio-example-edit')).toBeDisabled()
  await page.getByTestId('prompt-studio-example').fill('a red fox at dawn, golden light, oil painting')

  await page.getByTestId('prompt-studio-example-edit').click()
  await page.getByTestId('prompt-editor-mode-phrase').click()
  await page.getByTestId('prompt-editor-segment-2').click()
  // Keyboard: Delete removes the selected phrase.
  await page.keyboard.press('Delete')
  await page.getByTestId('prompt-editor-apply').click()
  await expect(page.getByTestId('prompt-editor')).toBeHidden()

  await expect(page.getByTestId('prompt-studio-example')).toHaveValue('a red fox at dawn, golden light')
  await expect(page.getByTestId('chat-input')).toHaveValue(TEMPLATE.replace('{prompt}', 'a red fox at dawn, golden light'))
})
