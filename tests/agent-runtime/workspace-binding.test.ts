import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  appendWorkspaceAuthorityPrompt,
  assertProviderWorkspace,
  resolveWorkspaceBinding,
  workspacePathsEqual
} from '../../src/server/agent-runtime/workspace-binding'

const root = mkdtempSync(join(tmpdir(), 'codetask-workspace-binding-'))
const realWorkspace = join(root, 'workspace-real')
const realRuntime = join(root, 'runtime-real')
const workspace = join(root, 'workspace')
const runtime = join(root, 'runtime')
mkdirSync(realWorkspace)
mkdirSync(realRuntime)
const canonicalWorkspace = realpathSync.native(realWorkspace)
const canonicalRuntime = realpathSync.native(realRuntime)
symlinkSync(realWorkspace, workspace, process.platform === 'win32' ? 'junction' : 'dir')
symlinkSync(realRuntime, runtime, process.platform === 'win32' ? 'junction' : 'dir')

test.after(() => {
  rmSync(root, { recursive: true, force: true })
})

test('workspace binding rejects relative paths and canonicalizes aliases once', () => {
  assert.throws(
    () => resolveWorkspaceBinding({ workspaceRoot: 'workspace', runtimeRoot: runtime }),
    (error: unknown) =>
      error instanceof Error &&
      'code' in error &&
      (error as { code?: string }).code === 'workspace.path_invalid'
  )

  const binding = resolveWorkspaceBinding({
    workspaceRoot: workspace,
    runtimeRoot: runtime
  })
  assert.equal(binding.workspaceRoot, canonicalWorkspace)
  assert.equal(binding.runtimeRoot, canonicalRuntime)
  assert.equal(binding.fingerprint.length, 64)
  assert.equal(workspacePathsEqual(workspace, realWorkspace), true)
})

test('workspace authority prompt makes the project root unambiguous', () => {
  const prompt = appendWorkspaceAuthorityPrompt('Existing role instructions.', canonicalWorkspace)
  assert.match(prompt, /\[CODETASK_WORKSPACE_AUTHORITY\]/)
  assert.match(prompt, new RegExp(canonicalWorkspace.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.match(prompt, /must never replace it/)
  assert.equal(appendWorkspaceAuthorityPrompt(prompt, canonicalWorkspace), prompt)
})

test('provider workspace mismatch fails closed', () => {
  const other = mkdtempSync(join(tmpdir(), 'codetask-workspace-other-'))
  try {
    assert.throws(
      () => assertProviderWorkspace('test-provider', canonicalWorkspace, other),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        (error as { code?: string }).code === 'provider.workspace_mismatch'
    )
  } finally {
    rmSync(other, { recursive: true, force: true })
  }
})
