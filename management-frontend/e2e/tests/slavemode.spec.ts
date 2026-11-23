import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';

const bundle = {
  format: 'offloadmq-comfy-workflow',
  version: 1,
  name: 'example',
  namespace: 'img-utils',
  task_types: { depth: { graph: {}, params: null } },
};

type Payload = Record<string, unknown>;
type Submission = { capability: string; payload: Payload; timeoutSecs: number };

async function mockSlavemode(
  page: Page,
  capabilities: string[],
  result: (task: Submission) => { status?: string; output?: unknown },
) {
  const submissions: Submission[] = [];
  await page.addInitScript(() => localStorage.setItem('offload-mq-mgmt-token', 'test-token'));
  await page.route('**/management/agents/list/online', route =>
    route.fulfill({ json: [{ uid: 'selected-agent', uidShort: 'selected', capabilities, tier: 0, capacity: 1 }] }),
  );
  await page.route('**/api/task/submit', async route => {
    expect(route.request().headers()['x-mgmt-api-key']).toBe('test-token');
    const task = route.request().postDataJSON() as Submission;
    submissions.push(task);
    await route.fulfill({ json: { id: { cap: task.capability, id: String(submissions.length) } } });
  });
  await page.route('**/api/task/poll/*/*', async route => {
    const taskId = Number(new URL(route.request().url()).pathname.split('/').pop());
    await route.fulfill({ json: { status: 'completed', ...result(submissions[taskId - 1]) } });
  });
  await page.goto('/ui/agents');
  await page.getByText('selected', { exact: true }).click();
  return submissions;
}

test('controls ComfyUI and transfers workflow bundles on the selected agent', async ({ page }) => {
  const capabilities = ['slavemode.comfy-ctrl', 'slavemode.comfy-export', 'slavemode.comfy-import'];
  const submissions = await mockSlavemode(page, capabilities, ({ capability, payload }) => {
    switch (capability) {
      case 'slavemode.comfy-ctrl':
        return { output: { state: ['status', 'stop'].includes(String(payload.action)) ? 'stopped' : 'running' } };
      case 'slavemode.comfy-export':
        return {
          output: {
            bundles: payload.workflow ? [bundle] : [bundle, { ...bundle, name: 'second' }],
            skipped: ['Unreadable workflow'],
          },
        };
      case 'slavemode.comfy-import':
        if (!payload.name) return { status: 'failed', output: { error: 'One bundle failed. Imported: img-utils.example' } };
        return { output: { imported: [{ name: payload.name, namespace: payload.namespace }] } };
      default:
        throw new Error(`Unexpected capability ${capability}`);
    }
  });
  await page.getByRole('button', { name: 'ComfyUI' }).click();
  const dialog = page.getByRole('dialog', { name: 'ComfyUI' });
  await expect(dialog.getByText('stopped', { exact: true })).toBeVisible();
  for (const [action, state] of [['Start', 'running'], ['Stop', 'stopped'], ['Restart', 'running']]) {
    await dialog.getByRole('button', { name: action, exact: true }).click();
    await expect(dialog.getByText(state, { exact: true })).toBeVisible();
  }

  await dialog.getByLabel('Workflow reference (optional)').fill('img-utils.example');
  const downloadEvent = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Download bundles' }).click();
  const download = await downloadEvent;
  expect(download.suggestedFilename()).toBe('img-utils.example.omqwf.json');
  expect(JSON.parse(await readFile(await download.path(), 'utf8'))).toEqual(bundle);
  await expect(dialog.getByText('Unreadable workflow')).toBeVisible();

  const bundleInput = dialog.getByLabel('Workflow bundle files');
  await bundleInput.setInputFiles({
    name: 'invalid.json', mimeType: 'application/json', buffer: Buffer.from('{'),
  });
  await expect(dialog.getByRole('alert')).toContainText('invalid JSON');
  await expect(dialog.getByRole('button', { name: 'Import bundles' })).toBeDisabled();

  await bundleInput.setInputFiles(await download.path());
  await dialog.getByLabel('Workflow name (optional)').fill('renamed');
  await dialog.getByLabel('Namespace', { exact: true }).selectOption({ label: 'imggen' });
  await dialog.getByLabel('Overwrite existing task types').check();
  await dialog.getByRole('button', { name: 'Import bundles' }).click();
  await expect(dialog.getByRole('status')).toHaveText('Imported renamed.');

  await dialog.getByLabel('Workflow reference (optional)').clear();
  const allDownloads = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Download bundles' }).click();
  const allBundles = await allDownloads;
  expect(allBundles.suggestedFilename()).toBe('comfy-workflows.omqwf.json');
  await bundleInput.setInputFiles(await allBundles.path());
  await expect(dialog.getByLabel('Workflow name (optional)')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Import bundles' }).click();
  await expect(dialog.getByRole('alert')).toHaveText('One bundle failed. Imported: img-utils.example');

  expect(submissions.map(task => task.payload)).toEqual([
    { runner: 'selected-agent', action: 'status' },
    { runner: 'selected-agent', action: 'start' },
    { runner: 'selected-agent', action: 'stop' },
    { runner: 'selected-agent', action: 'restart' },
    { runner: 'selected-agent', workflow: 'img-utils.example' },
    { runner: 'selected-agent', bundles: [bundle], name: 'renamed', namespace: '', overwrite: true },
    { runner: 'selected-agent' },
    { runner: 'selected-agent', bundles: [bundle, { ...bundle, name: 'second' }], overwrite: true },
  ]);
  expect(submissions[3].timeoutSecs).toBe(360);
});

test('runs force rescan and delete-only model commands on the selected agent', async ({ page }) => {
  const submissions = await mockSlavemode(
    page,
    ['slavemode.force-rescan', 'slavemode.ollama-delete', 'slavemode.onnx-models-delete', 'slavemode.comfy-export'],
    () => ({ output: { count: 4 } }),
  );
  await page.getByRole('button', { name: 'ComfyUI' }).click();
  const dialog = page.getByRole('dialog', { name: 'ComfyUI' });
  await expect(dialog.getByRole('button', { name: 'Download bundles' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Refresh status' })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Import bundles' })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Close' }).click();

  await page.getByRole('button', { name: 'Force rescan' }).click();
  await expect(page.getByText('4 caps detected', { exact: false })).toBeVisible();

  for (const [manager, model] of [['Ollama', 'qwen3:8b'], ['ONNX', 'nudenet']]) {
    await page.getByRole('button', { name: manager, exact: true }).click();
    await page.getByLabel('Model to delete').fill(model);
    page.once('dialog', confirmation => confirmation.accept());
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(page.getByText(`Deleted "${model}"`)).toBeVisible();
    const title = page.getByText(`${manager} Models`, { exact: true });
    await title.locator('..').getByRole('button', { name: '✕' }).last().click();
  }

  expect(submissions.map(({ capability, payload }) => ({ capability, payload }))).toEqual([
    { capability: 'slavemode.force-rescan', payload: { runner: 'selected-agent' } },
    { capability: 'slavemode.ollama-delete', payload: { runner: 'selected-agent', model: 'qwen3:8b' } },
    { capability: 'slavemode.onnx-models-delete', payload: { runner: 'selected-agent', model: 'nudenet' } },
  ]);
});
