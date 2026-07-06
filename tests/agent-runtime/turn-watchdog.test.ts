import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { TurnError } from '../../src/shared/turn-errors/turn-error.ts'
import {
  TurnWatchdog,
  isLongRunningTestCommand,
  turnWatchdogTimeoutError,
  resolveTurnWatchdogPolicy
} from '../../src/server/agent-runtime/turn-watchdog'
import { isRetryableTurnError } from '../../src/server/agent-runtime/retry'

describe('turn-watchdog', () => {
  it('detects common long-running test commands', () => {
    assert.equal(isLongRunningTestCommand('npm test'), true)
    assert.equal(isLongRunningTestCommand('pytest -q'), true)
    assert.equal(isLongRunningTestCommand('cargo test'), true)
    assert.equal(isLongRunningTestCommand('ls -la'), false)
  })

  it('uses longer idle for task-worker than conversation', () => {
    const worker = resolveTurnWatchdogPolicy('task-worker')
    const conversation = resolveTurnWatchdogPolicy('conversation')
    assert.ok(worker.idleMs > conversation.idleMs)
    assert.ok(worker.wallMs >= conversation.wallMs)
  })

  it('aborts when no first signal arrives', async () => {
    const watchdog = new TurnWatchdog({
      role: 'conversation',
      policy: {
        noFirstSignalMs: 30,
        idleMs: 60_000,
        wallMs: 120_000,
        longRunningToolMs: 120_000
      }
    })
    watchdog.arm()

    await assert.rejects(
      () =>
        watchdog.race(
          new Promise<string>((resolve) => {
            setTimeout(() => resolve('late'), 200)
          })
        ),
      (error: unknown) => {
        assert.ok(error instanceof TurnError)
        assert.equal(error.code, 'turn.watchdog_no_signal')
        return true
      }
    )

    watchdog.dispose()
  })

  it('refreshes idle timer on activity', async () => {
    const watchdog = new TurnWatchdog({
      role: 'conversation',
      policy: {
        noFirstSignalMs: 20,
        idleMs: 80,
        wallMs: 120_000,
        longRunningToolMs: 120_000
      }
    })
    watchdog.arm()
    watchdog.recordActivity('text_delta')

    const winner = await watchdog.race(
      new Promise<string>((resolve) => {
        setTimeout(() => resolve('ok'), 50)
      })
    )
    assert.equal(winner, 'ok')
    watchdog.dispose()
  })

  it('watchdog timeout errors are retryable at turn layer', () => {
    const error = turnWatchdogTimeoutError('idle', resolveTurnWatchdogPolicy('task-worker'))
    assert.equal(isRetryableTurnError(error), true)
  })
})
