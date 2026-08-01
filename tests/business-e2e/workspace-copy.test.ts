import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { initializeWorkspaceGitBoundary } from './supervisor/workspace-copy.ts'

test('case workspace git boundary hides parent-repository oracle files', () => {
  const root = mkdtempSync(join(tmpdir(), 'business-e2e-workspace-boundary-'))
  try {
    const outer = join(root, 'source-repo')
    const workspace = join(outer, 'tmp/codetask-business-e2e-run-1/workspaces/case-1')
    mkdirSync(workspace, { recursive: true })
    writeFileSync(join(outer, 'oracle-expected.json'), '{"secret":"do-not-expose"}\n', 'utf8')
    writeFileSync(join(workspace, 'README.md'), '# isolated case\n', 'utf8')

    const outerInit = spawnSync(
      'git',
      ['-c', 'init.defaultBranch=main', 'init', '--quiet', outer],
      {
        encoding: 'utf8',
        windowsHide: true
      }
    )
    assert.equal(outerInit.status, 0, outerInit.stderr)

    initializeWorkspaceGitBoundary(workspace)

    const topLevel = spawnSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: workspace,
      encoding: 'utf8',
      windowsHide: true
    })
    assert.equal(topLevel.status, 0, topLevel.stderr)
    assert.equal(realpathSync(resolve(topLevel.stdout.trim())), realpathSync(resolve(workspace)))

    const status = spawnSync('git', ['status', '--short', '--untracked-files=all'], {
      cwd: workspace,
      encoding: 'utf8',
      windowsHide: true
    })
    assert.equal(status.status, 0, status.stderr)
    assert.equal(status.stdout.trim(), '')
    assert.doesNotMatch(status.stdout, /oracle-expected\.json/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
