import { afterEach, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { captureWorkspace, continuationPrompt } from './capture'

const run = promisify(execFile)
const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

it('captures bounded git metadata and harness references without file contents or sensitive filenames', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'nexus-capture-'))
  roots.push(cwd)
  await run('git', ['init', '-b', 'main'], { cwd })
  await writeFile(path.join(cwd, 'tracked.ts'), 'old\n')
  await run('git', ['add', 'tracked.ts'], { cwd })
  await run('git', ['-c', 'user.email=fixture@example.invalid', '-c', 'user.name=Fixture', 'commit', '-m', 'fixture'], {
    cwd,
  })
  await writeFile(path.join(cwd, 'tracked.ts'), 'SECRET_FILE_CONTENT\nsecond\n')
  await writeFile(path.join(cwd, '.env.local'), 'SECRET_ENV_CONTENT')
  await mkdir(path.join(cwd, 'nexus-architecture-harness'))
  await writeFile(path.join(cwd, 'nexus-architecture-harness', 'README.md'), 'SECRET_HARNESS_CONTENT')
  await Promise.all(
    Array.from({ length: 210 }, (_, i) => writeFile(path.join(cwd, `untracked-${i}.txt`), 'SECRET_UNTRACKED_CONTENT')),
  )
  const state = await captureWorkspace(cwd)
  expect(state.branch).toBe('main')
  expect(state.modifiedFiles).toContainEqual({ path: 'tracked.ts', status: ' M', sizeBytes: 27 })
  expect(state.modifiedFiles.length).toBeLessThanOrEqual(200)
  expect(state.truncated).toBe(true)
  expect(state.diffStatistics).toEqual({ files: 1, insertions: 2, deletions: 1 })
  expect(state.harnessPaths).toContain('nexus-architecture-harness/README.md')
  expect(JSON.stringify(state)).not.toMatch(/SECRET_|\.env\.local/)
  expect(JSON.stringify(state).length).toBeLessThan(100000)
  const prompt = continuationPrompt({
    originalGoal: 'Finish implementation',
    currentUserInstruction: 'Continue',
    projectId: 'project',
    workspace: cwd,
    cwd,
    currentBranch: state.branch,
    taskStatus: 'switching',
    status: 'switching',
    completedWork: ['Published artifact'],
    pendingWork: ['Verify'],
    importantDecisions: [],
    modifiedFiles: state.modifiedFiles,
    gitStatus: state.gitStatus,
    gitDiffSummary: state.diffStatistics,
    relevantCommands: [],
    relevantTestResults: [],
    lastSuccessfulOperation: null,
    knownFailures: [],
    decisions: [],
    lastUserInstruction: 'Continue',
    sourceTool: 'codex',
    sourceConversation: 's',
    sourceResource: 'a',
    sourceSession: 's',
    workspaceState: state,
  })
  expect(prompt).toMatch(/reinspect/i)
  expect(prompt).toMatch(/do not replay/i)
  expect(prompt).toContain('Published artifact')
})
