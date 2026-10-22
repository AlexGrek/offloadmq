import { expect, test } from '@playwright/test'

test('chat uploads and sends Markdown, TXT, PDF and EPUB documents', async ({ page }) => {
  const registration = await page.request.post('/api/auth/register', {
    data: { login: `documents_${crypto.randomUUID()}`, password: 'testpass123' },
  })
  expect(registration.ok()).toBeTruthy()
  const { token } = await registration.json()
  const headers = { Authorization: `Bearer ${token}` }
  const creation = await page.request.post('/api/chats', { headers })
  expect(creation.status()).toBe(201)
  const chat = await creation.json()
  await page.addInitScript(value => localStorage.setItem('oai_token', value), token)

  // Uploads, persistence and downloads use the real backend. Capture only the
  // model request so this test doesn't require an online inference agent.
  const submitted: { attachment_ids: string[] }[] = []
  await page.routeWebSocket(/\/api\/ws\/chat/, ws => {
    ws.onMessage(raw => {
      const command = JSON.parse(String(raw))
      if (command.type === 'list_capabilities') {
        ws.send(JSON.stringify({
          type: 'capabilities', req_id: command.req_id,
          capabilities: [{ base: 'llm.test', tags: [], raw: 'llm.test', online: true }],
        }))
      } else if (command.type === 'chat') {
        submitted.push(command)
        ws.send(JSON.stringify({
          type: 'task:result', req_id: command.req_id, cap: 'llm.test', id: 'test-task',
          text: 'Received the documents.',
        }))
      }
    })
  })

  await page.goto('/app/chat')
  await page.getByTestId(`chat-item-${chat.id}`).click()
  const picker = page.locator('input[type="file"][accept*=".pdf"]')
  const accepted = (await picker.getAttribute('accept'))?.split(',')
  for (const ext of ['.md', '.txt', '.pdf', '.epub']) expect(accepted).toContain(ext)

  // The upload route preserves document bytes; extraction is covered by the
  // agent's real PDF/EPUB/text fixtures in test_llm_attachments.py.
  const documents = [
    { name: 'notes.md', mimeType: 'text/markdown', buffer: Buffer.from('# Notes\n\nПривіт') },
    { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('Plain text notes') },
    { name: 'report.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\nUpload payload') },
    { name: 'book.EPUB', mimeType: 'application/epub+zip', buffer: Buffer.from('EPUB upload payload') },
  ]
  const ids: string[] = []
  for (const document of documents) {
    const uploaded = page.waitForResponse(response =>
      response.url().endsWith('/api/chat/attachments/upload') && response.request().method() === 'POST',
    )
    await page.getByTestId('chat-attach-doc-btn').click()
    const chooser = page.waitForEvent('filechooser')
    await page.getByTestId('attach-upload-doc').click()
    await (await chooser).setFiles(document)
    const response = await uploaded
    expect(response.status()).toBe(201)
    const { attachment } = await response.json()
    ids.push(attachment.id)
    await expect(page.getByTestId(`composer-chip-${attachment.id}`)).toContainText(document.name)
    await expect(page.getByTestId('composer-attach-error')).toHaveCount(0)

    const download = await page.request.get(`/api/chat/attachments/${attachment.id}/download`, { headers })
    expect(download.ok()).toBeTruthy()
    expect(await download.body()).toEqual(document.buffer)
  }

  await page.getByTestId('chat-input').fill('Summarize the attached documents.')
  await page.getByTestId('send-btn').click()
  await expect.poll(() => submitted.length).toBe(1)
  expect(submitted[0].attachment_ids).toEqual(ids)
  await expect(page.getByTestId('composer-attachments')).toHaveCount(0)
  for (const id of ids) await expect(page.getByTestId(`attachment-doc-${id}`)).toBeVisible()
  await page.request.delete(`/api/chats/${chat.id}`, { headers })
})
