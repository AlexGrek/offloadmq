import { expect, test, type Page } from '@playwright/test'

/**
 * Prompt Studio (`/app/prompt-studio`): Enter adds a newline, Ctrl/⌘+Enter sends,
 * the example prompt is rendered through the message template into a preview,
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
  /** What `GET /api/chats/{id}/messages` returns. */
  restMessages: Record<string, unknown>[]
  /** When true the socket reports queued + "starting" progress but never the result. */
  holdResults: boolean
}

const defaultReply = (n: number) => '```\n' + REPLY_PROMPT + (n > 1 ? ` #${n}` : '') + '\n```'

async function mockApi(page: Page, reply: (n: number) => string = defaultReply): Promise<Captured> {
  const captured: Captured = {
    createdChats: [],
    wsChats: [],
    recentPrompts: [],
    imageJobs: [],
    restMessages: [],
    holdResults: false,
  }

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
        if (captured.holdResults) {
          ws.send(JSON.stringify({
            type: 'task:progress', req_id: msg.req_id, cap: 'llm.artist', id: `t${n}`, status: 'running', stage: 'starting',
          }))
          return
        }
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
      return json(captured.createdChats.map((body, i) => ({
        id: `studio-${i + 1}`, title: 'Lighthouse', system_prompt: 'x', last_model: 'llm.artist',
        kind: body.kind, created_at: now, updated_at: now,
      })))
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
    if (/^\/api\/chats\/[^/]+\/messages$/.test(pathname)) return json(captured.restMessages)
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
  // No example: the session is named after the message template.
  expect(captured.createdChats[0].title).toBe(TEMPLATE)
  // Freeform first message — no template was used, so none is recorded.
  expect(captured.recentPrompts.filter(p => p.bucket === 'prompt-studio-user')).toHaveLength(0)
})

test('no first-message preview; session is titled by the example; replies offer another-one and Use as prompt', async ({ page }) => {
  const captured = await mockApi(page)
  await page.goto('/app/prompt-studio')

  // During setup the message box lives inside the form — no separate chat bar.
  await expect(page.getByTestId('chat-input')).toHaveCount(1)
  await expect(page.getByTestId('prompt-studio-setup').getByTestId('chat-input')).toBeVisible()
  await expect(page.getByText('First message', { exact: true })).toHaveCount(0)

  await page.getByTestId('prompt-studio-example').fill('a red fox at dawn')
  const input = page.getByTestId('chat-input')
  // Typing the example does not mirror into the message box.
  await expect(input).toHaveValue('')

  await page.getByTestId('prompt-studio-template').fill('Riff on: {prompt}')

  // Extra text in the message box is appended to the rendered message.
  await input.fill('Make it moodier.')
  await page.getByTestId('send-btn').click()
  await expect.poll(() => captured.wsChats.length).toBe(1)
  expect(captured.wsChats[0].content).toBe('Riff on: a red fox at dawn\n\nMake it moodier.')
  // The session is named after the example prompt, not the (near-identical) first message.
  expect(captured.createdChats[0].title).toBe('a red fox at dawn')
  // After the first message the composer moves to the chat bar and setup disappears.
  await expect(page.getByTestId('prompt-studio-setup')).toHaveCount(0)
  await expect(input).toHaveValue('')
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
  await page.getByTestId('prompt-studio-generate-size-1920x1080').click()
  await page.getByTestId('prompt-studio-generate-submit').click()

  await expect.poll(() => captured.imageJobs.length).toBe(1)
  expect(captured.imageJobs[0]).toMatchObject({
    capability: 'imggen.flux',
    prompt: REPLY_PROMPT,
    width: 1920,
    height: 1080,
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
  await page.getByTestId('prompt-editor-size-1024x1536').click()
  await expect(page.getByTestId('prompt-editor-model')).toHaveValue('imggen.flux')
  await page.getByTestId('prompt-editor-generate').click()
  await expect.poll(() => captured.imageJobs.length).toBe(1)
  expect(captured.imageJobs[0]).toMatchObject({ prompt: edited, width: 1024, height: 1536, workflow: 'txt2img' })
  await expect(page.getByTestId('prompt-editor-notice')).toContainText('Started 1 image')
  await expect(editor).toBeVisible()

  // Use hands the edited prompt to Image Generation.
  await page.getByTestId('prompt-editor-use').click()
  await expect(page).toHaveURL(/\/app\/images$/)
  await expect(page.getByTestId('imggen-prompt')).toHaveValue(edited)
  await expect(page.getByTestId('imggen-width')).toHaveValue('1024')
  await expect(page.getByTestId('imggen-height')).toHaveValue('1536')
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
})

/** Leave Prompt Studio and come back without a page reload (app state survives). */
async function leaveAndReturn(page: Page, whileAway?: () => Promise<void>) {
  await page.evaluate(() => {
    window.history.pushState({}, '', '/app/images')
    window.dispatchEvent(new PopStateEvent('popstate'))
  })
  await expect(page.getByTestId('imggen-prompt')).toBeVisible()
  await whileAway?.()
  await page.goBack()
  await page.getByTestId('chat-item-studio-1').click()
}

/** The in-transcript "thinking" bubble (the Progress drawer may show the same label). */
const thinking = (page: Page) => page.getByTestId('messages-area').getByText('Starting…')

const userRow = { id: 'm1', role: 'user', content: 'Give me a prompt', status: 'complete', model: null, created_at: now }

test('a reply that finished while the page was closed shows as finished, not "Starting…"', async ({ page }) => {
  const captured = await mockApi(page)
  captured.holdResults = true
  await startSession(page, captured)
  await expect(thinking(page)).toBeVisible()

  // The agent finishes while the user is on another page: the DB has the reply,
  // but the result event went to the socket that is gone.
  captured.restMessages = [
    userRow,
    { id: 'm2', role: 'assistant', content: REPLY_PROMPT, status: 'complete', model: 'llm.artist', created_at: now },
  ]
  // Record whether a thinking bubble shows up at any moment after returning — the
  // stall watchdog would clear it a few seconds later, so a plain assertion misses it.
  await leaveAndReturn(page, () =>
    page.evaluate(() => {
      const w = window as unknown as { sawThinking: boolean }
      w.sawThinking = false
      new MutationObserver(() => {
        const area = document.querySelector('[data-testid="messages-area"]')
        if (area?.textContent?.includes('Starting…')) w.sawThinking = true
      }).observe(document.body, { subtree: true, childList: true, characterData: true })
    }),
  )

  await expect(page.getByTestId('messages-area').getByText(REPLY_PROMPT)).toBeVisible()
  await page.waitForTimeout(500)
  expect(await page.evaluate(() => (window as unknown as { sawThinking: boolean }).sawThinking)).toBe(false)
  await expect(thinking(page)).toHaveCount(0)
  await expect(page.getByTestId('prompt-studio-another')).toBeVisible()
  await expect(page.getByTestId('prompt-studio-use-as-prompt')).toHaveCount(1)
})

test('a reply still running when the page reopens resolves once the DB finalizes it', async ({ page }) => {
  const captured = await mockApi(page)
  captured.holdResults = true
  await startSession(page, captured)

  captured.restMessages = [
    userRow,
    { id: 'm2', role: 'assistant', content: '', status: 'pending', model: 'llm.artist', created_at: now },
  ]
  await leaveAndReturn(page)
  await expect(thinking(page)).toBeVisible()

  // The background worker finalizes the row; the stall watchdog polls and picks it up.
  captured.restMessages = [
    userRow,
    { id: 'm2', role: 'assistant', content: REPLY_PROMPT, status: 'complete', model: 'llm.artist', created_at: now },
  ]
  await expect(page.getByTestId('messages-area').getByText(REPLY_PROMPT)).toBeVisible({ timeout: 10_000 })
  await expect(thinking(page)).toHaveCount(0)
})
