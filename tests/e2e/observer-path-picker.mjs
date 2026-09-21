import assert from 'node:assert/strict'

// Deterministic browser boundary coverage. Actual Windows dialogs are verified separately,
// so CI never opens an unattended native dialog on its host.
export async function prepareObserverPathPicker(page) {
  const responses = [
    { kind: 'directory', status: 200, body: { path: 'D:\\记录 空格\\sessions' } },
    { kind: 'file', status: 200, body: { path: 'D:\\记录 空格\\rollout.jsonl' } },
    { kind: 'directory', status: 200, body: { path: null } },
    {
      kind: 'file',
      status: 409,
      body: { error: { code: 'picker_closed', message: '系统选择器已关闭或超时，请重试' } },
    },
  ]
  await page.route('**/api/local/observer-path', async (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { available: true, reason: null } })
    const response = responses.shift()
    assert.ok(response, 'unexpected native picker invocation')
    assert.deepEqual(route.request().postDataJSON(), { kind: response.kind })
    assert.ok(route.request().headers()['x-csrf-token'])
    await route.fulfill({ status: response.status, json: response.body })
  })
  return async (dialog) => {
    const input = dialog.getByLabel('本机 Codex 记录路径', { exact: true })
    await input.fill('C:/manual/sessions')
    await dialog.getByRole('button', { name: '选择文件夹', exact: true }).click()
    await dialog.getByRole('status').filter({ hasText: '已填入所选路径' }).waitFor()
    assert.equal(await input.inputValue(), 'D:\\记录 空格\\sessions')
    await dialog.getByRole('button', { name: '选择 JSONL 文件', exact: true }).click()
    await page.waitForFunction(() =>
      [...document.querySelectorAll('input')].some((i) => i.value.endsWith('rollout.jsonl')),
    )
    assert.equal(await input.inputValue(), 'D:\\记录 空格\\rollout.jsonl')
    await dialog.getByRole('button', { name: '选择文件夹', exact: true }).click()
    await dialog.getByText('已取消选择，原路径保持不变。', { exact: true }).waitFor()
    assert.equal(await input.inputValue(), 'D:\\记录 空格\\rollout.jsonl')
    await dialog.getByRole('button', { name: '选择 JSONL 文件', exact: true }).click()
    await dialog.getByRole('alert').filter({ hasText: '系统选择器已关闭或超时，请重试' }).waitFor()
    assert.equal(await input.inputValue(), 'D:\\记录 空格\\rollout.jsonl')
    await input.fill('/local/codex/sessions')
    assert.equal(responses.length, 0)
    await page.screenshot({ path: '.test-artifacts/observer-path-picker-e2e.png' })
    await page.unroute('**/api/local/observer-path')
  }
}
