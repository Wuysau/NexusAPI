import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const modulePath = '../../scripts/validate-ci.mjs'
const { validateWorkflow } = await import(modulePath)
const workflow = readFileSync('.github/workflows/ci.yml', 'utf8')

describe('production CI governance', () => {
  it('accepts the repository workflow with all required gates', () => {
    expect(validateWorkflow(workflow)).toEqual([])
  })
  it('rejects duplicate job identifiers instead of silently losing security work', () => {
    expect(validateWorkflow('jobs:\n  security: {}\n  security: {}\n').join(' ')).toMatch(/duplicate/i)
  })
  it('rejects a removed migration gate', () => {
    expect(validateWorkflow(workflow.replace('ci-gate.mjs migration', 'ci-gate.mjs unit')).join(' ')).toContain(
      'migration',
    )
  })
  it('rejects errors being converted into green checks', () => {
    expect(
      validateWorkflow(workflow.replace('name: Install', 'continue-on-error: true\n        name: Install')).join(' '),
    ).toContain('continue-on-error')
  })
  it('requires evidence even when a gate fails', () => {
    expect(validateWorkflow(workflow.replace('if: always()', 'if: success()')).join(' ')).toContain('evidence')
    expect(
      validateWorkflow(workflow.replace('include-hidden-files: true', 'include-hidden-files: false')).join(' '),
    ).toContain('evidence')
  })
  it('rejects integration preceding the real migration', () => {
    const swapped = workflow
      .replace('ci-gate.mjs migration', 'ci-gate.mjs REPLACE')
      .replace('ci-gate.mjs integration', 'ci-gate.mjs migration')
      .replace('ci-gate.mjs REPLACE', 'ci-gate.mjs integration')
    expect(validateWorkflow(swapped).join(' ')).toContain('before integration')
  })
  it('has no empty-suite success escape hatch', () => {
    const scripts = JSON.parse(readFileSync('package.json', 'utf8')).scripts
    for (const name of ['test:unit', 'test:contract', 'test:integration', 'test:security'])
      expect(scripts[name]).not.toContain('passWithNoTests')
  })
  it('rejects a disabled job and shell success masking', () => {
    expect(
      validateWorkflow(workflow.replace('      - name: Format', '      - if: false\n        name: Format')).join(' '),
    ).toContain('conditional')
    expect(
      validateWorkflow(workflow.replace('    timeout-minutes: 60', '    if: false\n    timeout-minutes: 60')).join(' '),
    ).toContain('conditional')
    expect(validateWorkflow(workflow.replace('ci-gate.mjs format', 'ci-gate.mjs format; true')).join(' ')).toContain(
      'exact fixed command',
    )
  })
})
