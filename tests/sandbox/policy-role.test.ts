import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { policyForRoleV2 } from '../../src/server/sandbox/policy'

test('conversation workspace is read-only unless it is an isolated Change Set', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'codetask-policy-role-'))
  const workspaceRoot = join(root, 'workspace')
  const runtimeRoot = join(root, 'runtime')
  mkdirSync(workspaceRoot)
  mkdirSync(runtimeRoot)
  const canonicalWorkspace = realpathSync(workspaceRoot)
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const readOnly = policyForRoleV2({
    role: 'conversation',
    workspaceRoot,
    runtimeRoot,
    workspaceAccess: 'live-read'
  })
  assert.equal(readOnly.filesystem.allowedReadRoots.includes(canonicalWorkspace), true)
  assert.equal(readOnly.filesystem.allowedWriteRoots.includes(canonicalWorkspace), false)

  const isolated = policyForRoleV2({
    role: 'conversation',
    workspaceRoot,
    runtimeRoot,
    workspaceAccess: 'isolated-write'
  })
  assert.equal(isolated.filesystem.allowedWriteRoots.includes(canonicalWorkspace), true)
})
