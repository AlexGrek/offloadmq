import { test, expect, type Page } from '@playwright/test'

async function setup(page: Page, options: { noModels?: boolean; status?: string } = {}) {
  const submissions: Record<string, unknown>[] = []
  const events: string[] = []
  let status = options.status ?? 'completed'
  let jobId = '101'
  let request: Record<string, unknown> = {}
  await page.addInitScript(() => localStorage.setItem('oai_token', 'langgraph-test-token'))
  const detail = () => ({ job_id: jobId, status, prompt: 'My graph prompt', capability: 'llm-runtime.qwen3:8b', request,
    result: { text: 'Graph answer', stdout: 'Graph answer\n', stderr: 'Tool diagnostic', return_code: 0, data: { answer: 42 } },
    artifacts: [{ filename: 'report.md', content_type: 'text/markdown', size_bytes: 12 }], stage: null,
    error: status === 'failed' ? 'App exited with code 1' : null,
    offload_cap: 'llm-runtime.qwen3:8b', offload_task_id: 't1', created_at: '2026-11-14T00:00:00Z', updated_at: '2026-11-14T00:00:00Z' })
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname
    if (!path.startsWith('/api/')) return route.continue()
    const method = route.request().method()
    const json = (value: unknown) => route.fulfill({ json: value })
    if (path === '/api/me') return json({ id: 9, login: 'tester', used_storage_bytes: 0 })
    if (path === '/api/admin/am_i_admin') return json({ is_admin: false })
    if (path === '/api/progress/running') return json({ jobs: [] })
    if (path === '/api/langgraph/capabilities') return json(options.noModels ? [] : ['qwen3:8b', 'gemma3:12b'].map(m => ({ base: `llm-runtime.${m}`, tags: [], raw: `llm-runtime.${m}` })))
    if (path === '/api/langgraph/jobs' && method === 'POST') {
      request = route.request().postDataJSON(); submissions.push(request)
      return json({ job_id: '101', status: 'submitted' })
    }
    if (path === '/api/langgraph/jobs') return json(submissions.length ? [detail()] : [])
    if (path.endsWith('/cancel')) { status = 'canceled'; events.push('cancel'); return json({ status }) }
    if (path.endsWith('/retry')) { status = 'running'; jobId = '102'; events.push('retry'); return json({ job_id: jobId }) }
    if (path.endsWith('/poll')) { events.push('poll'); return json(detail()) }
    if (path === `/api/langgraph/jobs/${jobId}` && method === 'DELETE') { events.push('delete'); submissions.length = 0; return route.fulfill({ status: 204 }) }
    if (path === `/api/langgraph/jobs/${jobId}`) return json(detail())
    if (path.includes('/api/prompts/') && path.endsWith('/entries')) return json({ items: [{ id: 'p1', kind: 'starred', content: 'Library graph prompt', created_at: '', updated_at: '', last_used_at: '', preview_version: null }], next_cursor: null })
    if (path.startsWith('/api/prompts/')) return json({ id: 'p1' })
    return json({})
  })
  await page.goto('/app/langgraph')
  await expect(page.getByTestId('langgraph-page')).toBeVisible()
  if (!options.noModels) await expect(page.getByLabel('Primary model')).toHaveValue('llm-runtime.qwen3:8b')
  return { submissions, events }
}

test('edits code, pyproject, prompts and models; retains the saved snapshot', async ({ page }) => {
  const { submissions } = await setup(page)
  await expect(page.getByRole('textbox', { name: 'main.py editor' })).toContainText('StateGraph')
  await page.getByRole('textbox', { name: 'main.py editor' }).fill('from tools import dummy_tool\nprint("custom")')
  await page.getByRole('tab', { name: 'tools.py', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'tools.py editor' })).toContainText('def dummy_tool')
  await page.getByRole('textbox', { name: 'tools.py editor' }).fill('def custom_tool():\n    return "hello"')
  await page.getByRole('tab', { name: 'pyproject.toml' }).click()
  await page.getByRole('textbox', { name: 'pyproject.toml editor' }).fill('[project]\ndependencies = ["langgraph"]')
  await page.getByRole('tab', { name: 'main.py', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'main.py editor' })).toContainText('custom')
  await page.getByRole('button', { name: 'Add model role' }).click()
  await page.getByLabel('Role 1 name').fill('critic')
  await page.getByLabel('Role 1 model').selectOption('gemma3:12b')
  await page.getByTestId('langgraph-user-prompt').fill('My graph prompt')
  await page.getByTestId('langgraph-system-prompt').fill('My system')
  await page.getByLabel('Allowed tools').selectOption('none')
  await page.getByTestId('langgraph-run').click()
  await expect(page.getByTestId('langgraph-status')).toHaveText('completed')
  expect(submissions[0]).toMatchObject({ models: { critic: 'gemma3:12b' }, main_py: 'from tools import dummy_tool\nprint("custom")', tools_py: 'def custom_tool():\n    return "hello"', pyproject: '[project]\ndependencies = ["langgraph"]', system_prompt: 'My system', user_prompt: 'My graph prompt', allowed_tools: [] })
  await expect(page.getByTestId('langgraph-result')).toContainText('Graph answer')
  await expect(page.getByTestId('langgraph-result')).toContainText('Tool diagnostic')
  await expect(page.getByTestId('langgraph-data')).toContainText('42')
  await expect(page.getByRole('link', { name: /Download report.md/ })).toHaveAttribute('href', /\/artifacts\/0\?token=/)
  await page.getByRole('button', { name: 'Edit as new run' }).click()
  await expect(page.getByTestId('langgraph-user-prompt')).toHaveValue('My graph prompt')
  await expect(page.getByRole('textbox', { name: 'main.py editor' })).toContainText('custom')
})

test('keeps draft across history navigation and reload; opens the prompt library', async ({ page }) => {
  await setup(page)
  await page.getByTestId('langgraph-user-prompt').fill('Retained draft')
  await page.getByTestId('langgraph-run').click()
  await expect(page.getByTestId('langgraph-status')).toHaveText('completed')
  await page.getByTestId('langgraph-new').click()
  await expect(page.getByTestId('langgraph-user-prompt')).toHaveValue('Retained draft')
  await page.waitForTimeout(500)
  await page.reload()
  await expect(page.getByTestId('langgraph-user-prompt')).toHaveValue('Retained draft')
  await page.getByTestId('langgraph-new-panel').getByTestId('prompt-list-open').last().click()
  await expect(page.getByText('Library graph prompt', { exact: true }).first()).toBeVisible()
})

test('requires enabled runtime models', async ({ page }) => {
  await setup(page, { noModels: true })
  await expect(page.getByTestId('langgraph-no-models')).toBeVisible()
  await expect(page.getByTestId('langgraph-run')).toBeDisabled()
})

test('cancel, retry, and terminal deletion use the run lifecycle', async ({ page }) => {
  const { events } = await setup(page, { status: 'running' })
  await page.getByTestId('langgraph-run').click()
  await expect(page.getByTestId('langgraph-status')).toHaveText('running')
  await page.getByRole('button', { name: 'Cancel run', exact: true }).click()
  await expect(page.getByTestId('langgraph-status')).toHaveText('canceled')
  await page.getByRole('button', { name: 'Retry run', exact: true }).click()
  await expect(page.getByTestId('langgraph-status')).toHaveText('running')
  await page.getByRole('button', { name: 'Cancel run', exact: true }).click()
  await expect(page.getByTestId('langgraph-status')).toHaveText('canceled')
  await page.getByRole('button', { name: 'Delete run', exact: true }).click()
  await expect(page.getByTestId('langgraph-new-panel')).toBeVisible()
  expect(events).toEqual(expect.arrayContaining(['cancel', 'retry', 'delete']))
})

test('mobile layout fits the viewport in both themes', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await setup(page)
  for (let i = 0; i < 2; i++) {
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await expect(page.getByTestId('langgraph-code-editor')).toBeVisible()
    await page.getByRole('button', { name: /Switch to .* mode/ }).click()
  }
})
