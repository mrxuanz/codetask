import assert from 'node:assert/strict'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  resolveCursorWorkspaceProjectSlug,
  slugifyCursorProjectPath
} from '../../src/server/agent-runtime/cursor-acp/cursor-workspace'
import { ensureCursorAcpRuntimeDirs } from '../../src/server/agent-runtime/env'

test('slugifyCursorProjectPath handles Windows and POSIX workspace paths', () => {
  assert.equal(
    slugifyCursorProjectPath('E:\\tasktest\\cli-bench\\swift-ridge-8818'),
    'E-tasktest-cli-bench-swift-ridge-8818'
  )
  assert.equal(slugifyCursorProjectPath('/home/user/my-project'), 'home-user-my-project')
})

test('ensureCursorAcpRuntimeDirs creates slugged Cursor project dir', () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), 'codetask-cursor-runtime-'))
  const workspace = 'E:\\tasktest\\cli-bench\\swift-ridge-8818'
  const slug = resolveCursorWorkspaceProjectSlug(workspace)

  ensureCursorAcpRuntimeDirs(runtimeRoot, workspace)

  assert.equal(existsSync(join(runtimeRoot, '.cursor', 'projects', slug)), true)
})
