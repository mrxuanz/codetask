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
import { streamSandboxedTurnViaSupervisor } from '../../src/server/sandbox/supervisor-client'
import {
  getSandboxSupervisorManager,
  SandboxSupervisorManager
} from '../../src/server/sandbox/supervisor-manager'
import { SandboxError } from '../../src/server/sandbox/types'

test('already-aborted supervisor turn fails before starting a provider session', async () => {
  const controller = new AbortController()
  controller.abort()

  await assert.rejects(
    async () => {
      for await (const _chunk of streamSandboxedTurnViaSupervisor({
        role: 'planner',
        coreCode: 'cursor',
        workspaceRoot: '/tmp',
        runtimeRoot: '/tmp',
        prompt: 'x',
        signal: controller.signal,
        capabilityProfile: 'planner-read'
      })) {
        // should not yield
      }
    },
    (error: unknown) => error instanceof SandboxError && error.code === 'sandbox.turn.cancelled'
  )
})

test('supervisor client publishes completed only after worker cleanup exits successfully', async () => {
  const manager = getSandboxSupervisorManager()
  const originalEnsureReady = manager.ensureReady
  const originalSend = manager.send
  let sessionId = ''

  manager.ensureReady = async () => {}
  manager.send = (command) => {
    if (command.type !== 'start-turn') return
    sessionId = command.sessionId
    queueMicrotask(() => {
      manager.emit('event', {
        type: 'chunk',
        sessionId,
        chunk: { type: 'completed', reply: '', runtimeSessionId: 'runtime-1' }
      })
    })
  }

  try {
    const stream = streamSandboxedTurnViaSupervisor({
      role: 'planner',
      coreCode: 'cursor',
      workspaceRoot: '/tmp',
      runtimeRoot: '/tmp',
      prompt: 'x',
      capabilityProfile: 'planner-read'
    })
    let settled = false
    const firstPromise = stream.next().finally(() => {
      settled = true
    })

    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.ok(sessionId)
    assert.equal(settled, false, 'completed must remain buffered before the exit event')

    manager.emit('event', {
      type: 'exit',
      sessionId,
      code: 0,
      status: 'exited'
    })

    const first = await firstPromise
    assert.deepEqual(first, {
      done: false,
      value: { type: 'completed', reply: '', runtimeSessionId: 'runtime-1' }
    })
    assert.equal((await stream.next()).done, true)
  } finally {
    manager.ensureReady = originalEnsureReady
    manager.send = originalSend
  }
})

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
  let crashCount = 0
  manager.on('crash', () => {
    crashCount += 1
  })

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
  assert.ok(crashCount >= 1, 'recycle must fail streams attached to the replaced supervisor')

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
