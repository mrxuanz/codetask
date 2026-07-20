import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { mock } from 'node:test'
import {
  CLIENT_CANCEL_DRAIN_TIMEOUT_MS,
  SUPERVISOR_CANCEL_DRAIN_TIMEOUT_MS,
  armCancelDrainWatchdog
} from '../../src/server/sandbox/cancel-drain-watchdog'
import {
  launchSandboxedWorker,
  pollSandboxExit,
  readSandboxStdoutLines
} from '../../src/server/sandbox/launcher'
import { policyForRole } from '../../src/server/sandbox/policy'
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

test('launchSandboxedWorker kills immediately when signal is already aborted', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codetask-launcher-abort-'))
  try {
    const policy = policyForRole({
      role: 'planner',
      workspaceRoot: root,
      runtimeRoot: root
    })
    const controller = new AbortController()
    controller.abort()

    const spawned = await launchSandboxedWorker({
      policy,
      command: process.platform === 'win32' ? 'ping' : 'sleep',
      args: process.platform === 'win32' ? ['-n', '30', '127.0.0.1'] : ['30'],
      env: {},
      signal: controller.signal
    })

    let code: number | null = null
    for (let i = 0; i < 100; i += 1) {
      try {
        code = pollSandboxExit(spawned.handle)
      } catch (error) {
        if (error instanceof SandboxError && error.code === 'sandbox.child_closed') {
          code = -1
          break
        }
        throw error
      }
      if (code !== null) break
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    assert.notEqual(code, null, 'aborted launch must kill the child promptly')
    try {
      spawned.handle.close()
    } catch {
      // already closed
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
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
