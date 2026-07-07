import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { isLongRunningTestCommand, ProgressGuard } from '../../src/server/agent-runtime/progress-guard'

describe('progress-guard', () => {
  it('detects common long-running test commands', () => {
    assert.equal(isLongRunningTestCommand('npm test'), true)
    assert.equal(isLongRunningTestCommand('pytest -q'), true)
    assert.equal(isLongRunningTestCommand('cargo test'), true)
    assert.equal(isLongRunningTestCommand('ls -la'), false)
  })

  it('defers stalled while tools remain open', async () => {
    const prevWindow = process.env.CODETASK_TURN_PROGRESS_WINDOW_MS
    const prevStalled = process.env.CODETASK_TURN_STALLED_MS
    process.env.CODETASK_TURN_PROGRESS_WINDOW_MS = '25'
    process.env.CODETASK_TURN_STALLED_MS = '50'

    try {
      const guard = new ProgressGuard('task-worker')
      let stalled = false
      guard.on('stalled', () => {
        stalled = true
      })
      guard.start()
      guard.recordActivity('tool_started')

      await new Promise((resolve) => setTimeout(resolve, 120))
      assert.equal(stalled, false)
      guard.recordActivity('tool_completed')
      guard.dispose()
    } finally {
      if (prevWindow === undefined) delete process.env.CODETASK_TURN_PROGRESS_WINDOW_MS
      else process.env.CODETASK_TURN_PROGRESS_WINDOW_MS = prevWindow
      if (prevStalled === undefined) delete process.env.CODETASK_TURN_STALLED_MS
      else process.env.CODETASK_TURN_STALLED_MS = prevStalled
    }
  })

  it('emits stalled after zero-progress windows accumulate', async () => {
    const prevWindow = process.env.CODETASK_TURN_PROGRESS_WINDOW_MS
    const prevStalled = process.env.CODETASK_TURN_STALLED_MS
    process.env.CODETASK_TURN_PROGRESS_WINDOW_MS = '20'
    process.env.CODETASK_TURN_STALLED_MS = '40'

    try {
      const guard = new ProgressGuard('conversation')
      let stalledCount = 0
      guard.on('stalled', () => {
        stalledCount += 1
      })
      guard.start()

      await new Promise((resolve) => setTimeout(resolve, 120))
      assert.equal(stalledCount, 1)

      await new Promise((resolve) => setTimeout(resolve, 80))
      assert.equal(stalledCount, 1)
      guard.dispose()
    } finally {
      if (prevWindow === undefined) delete process.env.CODETASK_TURN_PROGRESS_WINDOW_MS
      else process.env.CODETASK_TURN_PROGRESS_WINDOW_MS = prevWindow
      if (prevStalled === undefined) delete process.env.CODETASK_TURN_STALLED_MS
      else process.env.CODETASK_TURN_STALLED_MS = prevStalled
    }
  })
})
