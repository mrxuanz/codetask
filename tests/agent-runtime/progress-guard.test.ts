import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  isLongRunningTestCommand,
  ProgressGuard,
  longRunningToolCapMs
} from '../../src/server/agent-runtime/progress-guard'

describe('progress-guard', () => {
  it('detects common long-running test commands', () => {
    assert.equal(isLongRunningTestCommand('npm test'), true)
    assert.equal(isLongRunningTestCommand('pytest -q'), true)
    assert.equal(isLongRunningTestCommand('cargo test'), true)
    assert.equal(isLongRunningTestCommand('ls -la'), false)
  })

  it('enterLongRunningTool accepts any non-empty command, not only tests', async () => {
    const prevWindow = process.env.CODETASK_TURN_PROGRESS_WINDOW_MS
    const prevStalled = process.env.CODETASK_TURN_STALLED_MS
    const prevCap = process.env.CODETASK_LONG_TOOL_CAP_MS
    process.env.CODETASK_TURN_PROGRESS_WINDOW_MS = '25'
    process.env.CODETASK_TURN_STALLED_MS = '50'
    process.env.CODETASK_LONG_TOOL_CAP_MS = '10_000'

    try {
      const guard = new ProgressGuard('task-worker')
      let stalled = false
      guard.on('stalled', () => {
        stalled = true
      })
      guard.start()
      guard.enterLongRunningTool('npm run build')
      guard.enterLongRunningTool('') // empty must be ignored

      await new Promise((resolve) => setTimeout(resolve, 120))
      assert.equal(stalled, false)
      guard.exitLongRunningTool()
      guard.dispose()
    } finally {
      if (prevWindow === undefined) delete process.env.CODETASK_TURN_PROGRESS_WINDOW_MS
      else process.env.CODETASK_TURN_PROGRESS_WINDOW_MS = prevWindow
      if (prevStalled === undefined) delete process.env.CODETASK_TURN_STALLED_MS
      else process.env.CODETASK_TURN_STALLED_MS = prevStalled
      if (prevCap === undefined) delete process.env.CODETASK_LONG_TOOL_CAP_MS
      else process.env.CODETASK_LONG_TOOL_CAP_MS = prevCap
    }
  })

  it('defers stalled while tools remain open within the wall-cap', async () => {
    const prevWindow = process.env.CODETASK_TURN_PROGRESS_WINDOW_MS
    const prevStalled = process.env.CODETASK_TURN_STALLED_MS
    const prevCap = process.env.CODETASK_LONG_TOOL_CAP_MS
    process.env.CODETASK_TURN_PROGRESS_WINDOW_MS = '25'
    process.env.CODETASK_TURN_STALLED_MS = '50'
    process.env.CODETASK_LONG_TOOL_CAP_MS = '10_000'

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
      if (prevCap === undefined) delete process.env.CODETASK_LONG_TOOL_CAP_MS
      else process.env.CODETASK_LONG_TOOL_CAP_MS = prevCap
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

  it('open tools stop suppressing stall after the absolute wall-cap (C.2 hole)', async () => {
    const prevWindow = process.env.CODETASK_TURN_PROGRESS_WINDOW_MS
    const prevStalled = process.env.CODETASK_TURN_STALLED_MS
    const prevCap = process.env.CODETASK_LONG_TOOL_CAP_MS
    process.env.CODETASK_TURN_PROGRESS_WINDOW_MS = '20'
    process.env.CODETASK_TURN_STALLED_MS = '40'
    process.env.CODETASK_LONG_TOOL_CAP_MS = '30'

    try {
      assert.equal(longRunningToolCapMs(), 30)
      const guard = new ProgressGuard('task-worker')
      let stalled = false
      guard.on('stalled', () => {
        stalled = true
      })
      guard.start()
      // Simulate Codex/OpenCode double-count path: tool_started + enterLongRunningTool
      guard.recordActivity('tool_started')
      guard.enterLongRunningTool('npm run dev')

      // Wall expires at 30ms; then need stalled threshold 40ms → ~70ms+
      await new Promise((resolve) => setTimeout(resolve, 150))
      assert.equal(stalled, true)
      guard.dispose()
    } finally {
      if (prevWindow === undefined) delete process.env.CODETASK_TURN_PROGRESS_WINDOW_MS
      else process.env.CODETASK_TURN_PROGRESS_WINDOW_MS = prevWindow
      if (prevStalled === undefined) delete process.env.CODETASK_TURN_STALLED_MS
      else process.env.CODETASK_TURN_STALLED_MS = prevStalled
      if (prevCap === undefined) delete process.env.CODETASK_LONG_TOOL_CAP_MS
      else process.env.CODETASK_LONG_TOOL_CAP_MS = prevCap
    }
  })

  it('text activity within the wall-cap still keeps the turn alive', async () => {
    const prevWindow = process.env.CODETASK_TURN_PROGRESS_WINDOW_MS
    const prevStalled = process.env.CODETASK_TURN_STALLED_MS
    const prevCap = process.env.CODETASK_LONG_TOOL_CAP_MS
    process.env.CODETASK_TURN_PROGRESS_WINDOW_MS = '30'
    process.env.CODETASK_TURN_STALLED_MS = '80'
    process.env.CODETASK_LONG_TOOL_CAP_MS = '10_000'

    try {
      const guard = new ProgressGuard('task-worker')
      let stalled = false
      guard.on('stalled', () => {
        stalled = true
      })
      guard.start()
      guard.enterLongRunningTool('npm test')

      await new Promise((resolve) => setTimeout(resolve, 45))
      guard.recordActivity('tool_updated')
      await new Promise((resolve) => setTimeout(resolve, 45))
      assert.equal(stalled, false)
      guard.dispose()
    } finally {
      if (prevWindow === undefined) delete process.env.CODETASK_TURN_PROGRESS_WINDOW_MS
      else process.env.CODETASK_TURN_PROGRESS_WINDOW_MS = prevWindow
      if (prevStalled === undefined) delete process.env.CODETASK_TURN_STALLED_MS
      else process.env.CODETASK_TURN_STALLED_MS = prevStalled
      if (prevCap === undefined) delete process.env.CODETASK_LONG_TOOL_CAP_MS
      else process.env.CODETASK_LONG_TOOL_CAP_MS = prevCap
    }
  })

  it('counts provider_event and heartbeat as progress (stream liveness)', async () => {
    const prevWindow = process.env.CODETASK_TURN_PROGRESS_WINDOW_MS
    const prevStalled = process.env.CODETASK_TURN_STALLED_MS
    process.env.CODETASK_TURN_PROGRESS_WINDOW_MS = '25'
    process.env.CODETASK_TURN_STALLED_MS = '50'

    try {
      const guard = new ProgressGuard('planner')
      let stalled = false
      guard.on('stalled', () => {
        stalled = true
      })
      guard.start()

      await new Promise((resolve) => setTimeout(resolve, 30))
      guard.recordActivity('provider_event')
      await new Promise((resolve) => setTimeout(resolve, 30))
      guard.recordActivity('heartbeat')
      await new Promise((resolve) => setTimeout(resolve, 30))
      assert.equal(stalled, false)
      guard.dispose()
    } finally {
      if (prevWindow === undefined) delete process.env.CODETASK_TURN_PROGRESS_WINDOW_MS
      else process.env.CODETASK_TURN_PROGRESS_WINDOW_MS = prevWindow
      if (prevStalled === undefined) delete process.env.CODETASK_TURN_STALLED_MS
      else process.env.CODETASK_TURN_STALLED_MS = prevStalled
    }
  })
})
