import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  bootstrapRuntime,
  resetAppContextForTests
} from '../../src/server/bootstrap'
import {
  acquireWorkspaceLease,
  releaseWorkspaceLease,
  resetWorkspaceLeaseStateForTests
} from '../../src/server/legacy-control-plane/workspace-lease-store'
import { ensureStartupWorkloadReady } from '../../src/server/legacy-control-plane/workload-slot'
import { stopWorkloadReconcilerForTests } from '../../src/server/legacy-control-plane/reconcile'
import {
  releaseChatWorkspaceLease,
  resolveChatAccess,
  resolveChatSystemPrompt,
  resolveCreateTaskAccess,
  resolveCreateTaskSystemPrompt
} from '../../src/server/conversation/turn-policy'
import { savePromptSettings, loadPromptSettings } from '../../src/server/settings/prompts'

let dataDir = ''
let workspaceRoot = ''

async function setup(): Promise<void> {
  dataDir = mkdtempSync(join(tmpdir(), 'codetask-chat-policy-'))
  workspaceRoot = join(dataDir, 'workspace')
  mkdirSync(workspaceRoot, { recursive: true })
  await resetAppContextForTests()
  resetWorkspaceLeaseStateForTests()
  bootstrapRuntime({ dataDir })
  await ensureStartupWorkloadReady()
  stopWorkloadReconcilerForTests()
}

async function teardown(): Promise<void> {
  await resetAppContextForTests()
  resetWorkspaceLeaseStateForTests()
  try {
    rmSync(dataDir, { recursive: true, force: true })
  } catch {
    // ignore
  }
}

test('chat policy defaults to exclusive-write when the directory is free', async () => {
  await setup()
  try {
    const access = resolveChatAccess({
      workspacePath: workspaceRoot,
      turnId: 'turn-free',
      coreCode: 'cursorcli'
    })
    assert.equal(access.workspaceAccess, 'exclusive-write')
    assert.equal(access.capabilityProfile, 'chat-write')
    assert.ok(access.workspaceLease)
    releaseChatWorkspaceLease(access.workspaceLease)
  } finally {
    await teardown()
  }
})

test('chat policy downgrades to live-read when a job holds the directory lease', async () => {
  await setup()
  try {
    const jobLease = acquireWorkspaceLease({
      workspacePath: workspaceRoot,
      ownerKind: 'thread_job',
      ownerId: 'job-running'
    })
    assert.ok(jobLease)

    const access = resolveChatAccess({
      workspacePath: workspaceRoot,
      turnId: 'turn-blocked',
      coreCode: 'cursorcli'
    })
    assert.equal(access.workspaceAccess, 'live-read')
    assert.equal(access.capabilityProfile, 'chat-read')
    assert.equal(access.workspaceLease, null)

    releaseWorkspaceLease(jobLease.leaseId)
  } finally {
    await teardown()
  }
})

test('create-task policy stays read-only even when the directory is free', async () => {
  await setup()
  try {
    const access = resolveCreateTaskAccess({
      workspacePath: workspaceRoot,
      coreCode: 'cursorcli'
    })
    assert.equal(access.workspaceAccess, 'live-read')
    assert.equal(access.capabilityProfile, 'create-task-read')
    assert.equal(access.workspaceLease, null)
  } finally {
    await teardown()
  }
})

test('chat system prompt is empty by default and honors settings custom body', async () => {
  await setup()
  try {
    assert.equal(resolveChatSystemPrompt(), '')

    const current = loadPromptSettings()
    savePromptSettings({
      ...current,
      conversation: { body: 'Custom chat policy prompt', useDefault: false }
    })
    assert.equal(resolveChatSystemPrompt(), 'Custom chat policy prompt')

    savePromptSettings({
      ...current,
      conversation: { body: '', useDefault: true }
    })
    assert.equal(resolveChatSystemPrompt(), '')
  } finally {
    await teardown()
  }
})

test('create-task system prompt still includes draft workflow and not chat emptiness', async () => {
  await setup()
  try {
    const prompt = resolveCreateTaskSystemPrompt({
      turnRole: 'chat',
      mcpToolsAvailable: true
    })
    assert.match(prompt, /propose_task_draft/)
    assert.match(prompt, /requirements coordinator/)
  } finally {
    await teardown()
  }
})
