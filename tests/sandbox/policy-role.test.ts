import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createSandboxPolicy } from '../../src/server/sandbox/policy'
import { assertSandboxWorkspaceAccess } from '../../src/server/sandbox/workspace-access'

test('conversation workspace stays read-only even if exclusive access is requested', (t) => {
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
  assert.equal(readOnly.filesystem.allowedReadRoots.includes(canonicalWorkspace), true)
  assert.equal(readOnly.filesystem.allowedWriteRoots.includes(canonicalWorkspace), false)
  assert.equal(readOnly.filesystem.protectedNames.includes('.git'), true)

  const forbiddenWrite = createSandboxPolicy({
    role: 'conversation',
    workspaceRoot,
    runtimeRoot,
    workspaceAccess: 'exclusive-write'
  })
  assert.equal(forbiddenWrite.filesystem.allowedWriteRoots.includes(canonicalWorkspace), false)
})

test('task-worker workspace writes require a matching durable Job lease', () => {
  assert.throws(
    () =>
      assertSandboxWorkspaceAccess({
        role: 'task-worker',
        capabilityProfile: 'task-sandbox',
        workspaceAccess: 'exclusive-write',
        jobId: 'job-1'
      }),
    (error: unknown) =>
      error instanceof Error &&
      'code' in error &&
      (error as { code?: string }).code === 'sandbox.workspace_lease_mismatch'
  )

  assert.doesNotThrow(() =>
    assertSandboxWorkspaceAccess({
      role: 'task-worker',
      capabilityProfile: 'task-sandbox',
      workspaceAccess: 'exclusive-write',
      workspaceLease: { leaseId: 'lease-1', ownerKind: 'job', ownerId: 'job-1' },
      jobId: 'job-1'
    })
  )
})

test('verifiers and conversations can never upgrade themselves to workspace write', () => {
  for (const [role, capabilityProfile] of [
    ['conversation', 'chat-write'],
    ['work-verifier', 'verifier-sandbox'],
    ['slice-verifier', 'verifier-sandbox'],
    ['milestone-verifier', 'verifier-sandbox']
  ] as const) {
    assert.throws(
      () =>
        assertSandboxWorkspaceAccess({
          role,
          capabilityProfile,
          workspaceAccess: 'exclusive-write',
          workspaceLease: { leaseId: 'lease-1', ownerKind: 'job', ownerId: 'job-1' },
          jobId: 'job-1'
        }),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        (error as { code?: string }).code === 'sandbox.workspace_write_forbidden'
    )
  }
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

test('read-only roles cannot gain workspace writes through auxiliary roots', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'codetask-policy-overlap-'))
  const workspaceRoot = join(root, 'workspace')
  const runtimeRoot = join(root, 'runtime')
  const workspaceChild = join(workspaceRoot, 'provider-state')
  mkdirSync(workspaceChild, { recursive: true })
  mkdirSync(runtimeRoot)
  t.after(() => rmSync(root, { recursive: true, force: true }))

  assert.throws(
    () =>
      createSandboxPolicy({
        role: 'planner',
        workspaceRoot,
        runtimeRoot,
        providerWriteRoots: [workspaceChild],
        workspaceAccess: 'live-read'
      }),
    (error: unknown) =>
      error instanceof Error &&
      'code' in error &&
      (error as { code?: string }).code === 'sandbox.policy.workspace_write_overlap'
  )
})

test('runtime and verifier output roots must not overlap the workspace', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'codetask-policy-root-separation-'))
  const workspaceRoot = join(root, 'workspace')
  const runtimeInsideWorkspace = join(workspaceRoot, '.runtime')
  const runtimeRoot = join(root, 'runtime')
  const verifierInsideWorkspace = join(workspaceRoot, '.verification')
  mkdirSync(runtimeInsideWorkspace, { recursive: true })
  mkdirSync(runtimeRoot)
  mkdirSync(verifierInsideWorkspace)
  t.after(() => rmSync(root, { recursive: true, force: true }))

  assert.throws(
    () =>
      createSandboxPolicy({
        role: 'planner',
        workspaceRoot,
        runtimeRoot: runtimeInsideWorkspace
      }),
    (error: unknown) =>
      error instanceof Error &&
      'code' in error &&
      (error as { code?: string }).code === 'sandbox.policy.runtime_workspace_overlap'
  )

  assert.throws(
    () =>
      createSandboxPolicy({
        role: 'work-verifier',
        workspaceRoot,
        runtimeRoot,
        verifierOutputRoot: verifierInsideWorkspace
      }),
    (error: unknown) =>
      error instanceof Error &&
      'code' in error &&
      (error as { code?: string }).code === 'sandbox.policy.workspace_write_overlap'
  )
})
