import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import {
  CLIENT_CANCEL_DRAIN_TIMEOUT_MS,
  SUPERVISOR_CANCEL_DRAIN_TIMEOUT_MS,
  armCancelDrainWatchdog
} from '../../src/server/sandbox/cancel-drain-watchdog'
import {
  launchSandboxedWorker,
  readSandboxStdoutLines,
  reapSandboxChild
} from '../../src/server/sandbox/launcher'
import { SandboxError } from '../../src/server/sandbox/types'

test('stdout reader stops when cancellation arrives before child exit is observable', async () => {
  const controller = new AbortController()
  let reads = 0
  const handle = {
    readStdoutChunk: () => {
      reads += 1
      controller.abort()
      return Buffer.alloc(0)
    },
    pollExit: () => null
  }

  await assert.rejects(
    async () => {
      for await (const _line of readSandboxStdoutLines(handle as never, {
        keepReading: () => true,
        pollExit: () => null,
        signal: controller.signal
      })) {
        // no output expected
      }
    },
    (error: unknown) => {
      assert.ok(error instanceof SandboxError)
      assert.equal(error.code, 'sandbox.turn.cancelled')
      return true
    }
  )
  assert.equal(reads, 1)
})

test('stdout reader exits even when pollExit stays null after kill-driven abort', async () => {
  const controller = new AbortController()
  let reads = 0
  const handle = {
    readStdoutChunk: () => {
      reads += 1
      if (reads === 2) controller.abort()
      return Buffer.alloc(0)
    },
    pollExit: () => null,
    kill: () => {}
  }

  await assert.rejects(
    async () => {
      for await (const _line of readSandboxStdoutLines(handle as never, {
        keepReading: () => true,
        pollExit: () => null,
        signal: controller.signal
      })) {
        // drain until abort
      }
    },
    (error: unknown) => error instanceof SandboxError && error.code === 'sandbox.turn.cancelled'
  )
  assert.ok(reads >= 2)
})

test('stdout reader treats an already-closed child as exited', async () => {
  const handle = {
    readStdoutChunk: () => Buffer.alloc(0)
  }
  const lines: string[] = []

  for await (const line of readSandboxStdoutLines(handle as never, {
    keepReading: () => true,
    pollExit: () => {
      throw new SandboxError('sandbox child closed', 'sandbox.child_closed')
    }
  })) {
    lines.push(line)
  }

  assert.deepEqual(lines, [])
})

test('launchSandboxedWorker rejects an already-aborted turn before native startup', async () => {
  const controller = new AbortController()
  controller.abort()

  await assert.rejects(
    () =>
      launchSandboxedWorker({
        policy: {} as never,
        command: 'unused',
        args: [],
        env: {},
        signal: controller.signal
      }),
    (error: unknown) => error instanceof SandboxError && error.code === 'sandbox.turn.cancelled'
  )
})

test('cancel drain watchdog fires after timeout when session stays active', () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    let fired = false
    const watchdog = armCancelDrainWatchdog({
      timeoutMs: SUPERVISOR_CANCEL_DRAIN_TIMEOUT_MS,
      isStale: () => false,
      onTimeout: () => {
        fired = true
      }
    })
    mock.timers.tick(SUPERVISOR_CANCEL_DRAIN_TIMEOUT_MS - 1)
    assert.equal(fired, false)
    mock.timers.tick(1)
    assert.equal(fired, true)
    watchdog.clear()
  } finally {
    mock.timers.reset()
  }
})

test('cancel drain watchdog skips stale sessions and clears cleanly', () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    let fired = false
    const watchdog = armCancelDrainWatchdog({
      timeoutMs: CLIENT_CANCEL_DRAIN_TIMEOUT_MS,
      isStale: () => true,
      onTimeout: () => {
        fired = true
      }
    })
    mock.timers.tick(CLIENT_CANCEL_DRAIN_TIMEOUT_MS)
    assert.equal(fired, false)
    watchdog.clear()

    const early = armCancelDrainWatchdog({
      timeoutMs: CLIENT_CANCEL_DRAIN_TIMEOUT_MS,
      isStale: () => false,
      onTimeout: () => {
        fired = true
      }
    })
    early.clear()
    mock.timers.tick(CLIENT_CANCEL_DRAIN_TIMEOUT_MS)
    assert.equal(fired, false)
  } finally {
    mock.timers.reset()
  }
})

test('reapSandboxChild cancellation kills but leaves handle closing to its caller', async () => {
  const controller = new AbortController()
  controller.abort()
  let killCount = 0
  let closeCount = 0

  const result = await reapSandboxChild(
    {
      pid: 123,
      kill: () => {
        killCount += 1
      },
      close: () => {
        closeCount += 1
      },
      pollExit: () => null
    } as never,
    { signal: controller.signal, maxWaitMs: 1 }
  )

  assert.deepEqual(result, { code: -1, status: 'cancelled' })
  assert.equal(killCount, 1)
  assert.equal(closeCount, 0)
})
