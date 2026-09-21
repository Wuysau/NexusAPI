import { describe, expect, it } from 'vitest'
import { getFileInfo } from 'prettier'

describe('formatter checkout boundary', () => {
  it('excludes other agents worktrees without excluding current product source', async () => {
    const options = { ignorePath: '.prettierignore', resolveConfig: false }
    const nested = await getFileInfo('.claude/worktrees/another-task/src/app/page.tsx', options)
    const current = await getFileInfo('src/components/Topbar.tsx', options)
    const regression = await getFileInfo('tests/contract/formatter-scope.test.ts', options)
    expect(nested.ignored).toBe(true)
    expect(current.ignored).toBe(false)
    expect(regression.ignored).toBe(false)
  })
})
