import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import {
  forceTerminateJobSandboxTurns,
  hasActiveJobSandboxTurns,
  registerJobTurnForTests,
  resetActiveJobTurnsForTests,
  streamSandboxedConversationTurn,
  waitForJobSandboxTurnsIdle
} from '../../src/server/sandbox/orchestrator'
import { SandboxSupervisorManager } from '../../src/server/sandbox/supervisor-manager'
import { SandboxError } from '../../src/server/sandbox/types'

test('aborted sandbox turn unregisters active job turn in finally', async () => {
  const previous = process.env.CODETASK_SANDBOX_SUPERVISOR
  process.env.CODETASK_SANDBOX_SUPERVISOR = '0'
  resetActiveJobTurnsForTests()
  const jobId = 'job-abort-unregister'
  const controller = new AbortController()
  controller.abort()

  try {
    await assert.rejects(async () => {
      for await (const _chunk of streamSandboxedConversationTurn({
        role: 'planner',
        coreCode: 'cursor',
        workspaceRoot: '/tmp',
        runtimeRoot: '/tmp',
        prompt: 'x',
        jobId,
        signal: controller.signal,
        capabilityProfile: 'planner-read'
      })) {
        // should not yield
      }
    })
    assert.equal(hasActiveJobSandboxTurns(jobId), false)
  } finally {
    resetActiveJobTurnsForTests()
    if (previous === undefined) delete process.env.CODETASK_SANDBOX_SUPERVISOR
    else process.env.CODETASK_SANDBOX_SUPERVISOR = previous
  }
})

test('forceTerminateJobSandboxTurns drains registered turns so waitIdle succeeds', async () => {
  resetActiveJobTurnsForTests()
  const jobId = 'job-force-terminate'
  const controller = new AbortController()
  registerJobTurnForTests(jobId, controller)

  assert.equal(hasActiveJobSandboxTurns(jobId), true)
  controller.signal.addEventListener(
    'abort',
    () => {
      resetActiveJobTurnsForTests()
    },
    { once: true }
  )

  await forceTerminateJobSandboxTurns(jobId)
  await waitForJobSandboxTurnsIdle(jobId, { timeoutMs: 1_000, pollMs: 10 })
  assert.equal(hasActiveJobSandboxTurns(jobId), false)
})

test('SandboxSupervisorManager recycle dedupes concurrent ensureReady without double spawn', async () => {
  const manager = new SandboxSupervisorManager()
  let spawnCount = 0

  const child = new EventEmitter() as EventEmitter & {
    connected: boolean
    killed: boolean
    send: (message: unknown) => boolean
    kill: (signal?: NodeJS.Signals) => boolean
  }
  child.connected = true
  child.killed = false
  child.send = (message: unknown) => {
    if (
      message &&
      typeof message === 'object' &&
      'type' in message &&
      (message as { type?: string }).type === 'shutdown'
    ) {
      queueMicrotask(() => child.emit('exit', 0, null))
    }
    return true
  }
  child.kill = () => {
    child.killed = true
    queueMicrotask(() => child.emit('exit', 1, 'SIGKILL'))
    return true
  }
  ;(manager as unknown as { child: typeof child; ready: boolean }).child = child
  ;(manager as unknown as { ready: boolean }).ready = true
  ;(manager as unknown as { spawn: () => Promise<void> }).spawn = async () => {
    spawnCount += 1
    const next = new EventEmitter() as typeof child
    next.connected = true
    next.killed = false
    next.send = (message: unknown) => {
      if (
        message &&
        typeof message === 'object' &&
        'type' in message &&
        (message as { type?: string }).type === 'shutdown'
      ) {
        queueMicrotask(() => next.emit('exit', 0, null))
      }
      return true
    }
    next.kill = () => {
      next.killed = true
      queueMicrotask(() => next.emit('exit', 0, null))
      return true
    }
    ;(manager as unknown as { ready: boolean; starting: boolean; child: typeof child }).ready = true
    ;(manager as unknown as { starting: boolean }).starting = false
    ;(manager as unknown as { child: typeof child }).child = next
  }

  const recycleA = manager.recycle('test-a')
  const readyDuring = manager.ensureReady()
  const recycleB = manager.recycle('test-b')

  await Promise.all([recycleA, readyDuring, recycleB])
  assert.equal(spawnCount, 1)

  await manager.shutdown()
})

test('SandboxSupervisorManager ensureReady rejects while shutting down', async () => {
  const manager = new SandboxSupervisorManager()
  await manager.shutdown()
  await assert.rejects(
    () => manager.ensureReady(),
    (error: unknown) =>
      error instanceof SandboxError && error.code === 'sandbox.supervisor.shutdown'
  )
})
