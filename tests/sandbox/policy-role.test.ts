import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createSandboxPolicy } from '../../src/server/sandbox/policy'
import { serializeSandboxPolicy } from '../../src/server/sandbox/wire'

test('conversation workspace is writable only with exclusive workspace access', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'codetask-policy-role-'))
  const workspaceRoot = join(root, 'workspace')
  const runtimeRoot = join(root, 'runtime')
  mkdirSync(workspaceRoot)
  mkdirSync(runtimeRoot)
  const canonicalWorkspace = realpathSync(workspaceRoot)
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const readOnly = createSandboxPolicy({
    role: 'conversation',
    workspaceRoot,
    runtimeRoot,
    workspaceAccess: 'live-read'
  })
  assert.equal('version' in readOnly, false)
  assert.equal(readOnly.filesystem.allowedReadRoots.includes(canonicalWorkspace), true)
  assert.equal(readOnly.filesystem.allowedWriteRoots.includes(canonicalWorkspace), false)
  assert.equal(readOnly.filesystem.protectedNames.includes('.git'), true)

  const writable = createSandboxPolicy({
    role: 'conversation',
    workspaceRoot,
    runtimeRoot,
    workspaceAccess: 'exclusive-write'
  })
  assert.equal(writable.filesystem.allowedWriteRoots.includes(canonicalWorkspace), true)
})

test('native policy version exists only at the wire boundary', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'codetask-policy-wire-'))
  const workspaceRoot = join(root, 'workspace')
  const runtimeRoot = join(root, 'runtime')
  mkdirSync(workspaceRoot)
  mkdirSync(runtimeRoot)
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const policy = createSandboxPolicy({
    role: 'planner',
    workspaceRoot,
    runtimeRoot,
    workspaceAccess: 'live-read'
  })
  const wire = JSON.parse(serializeSandboxPolicy(policy)) as Record<string, unknown>

  assert.equal('version' in policy, false)
  assert.equal(wire.version, 2)
})

test('sandbox policy rejects relative workspace roots instead of resolving process cwd', () => {
  assert.throws(
    () =>
      createSandboxPolicy({
        role: 'task-worker',
        workspaceRoot: 'relative-workspace',
        runtimeRoot: 'relative-runtime',
        workspaceAccess: 'exclusive-write'
      }),
    (error: unknown) =>
      error instanceof Error &&
      'code' in error &&
      (error as { code?: string }).code === 'sandbox.path.relative'
  )
})
