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
    const guard = new ProgressGuard('task-worker', {
      progressWindowMs: 25,
      stalledMs: 50,
      longRunningToolCapMs: 10_000
    })
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
  })

  it('defers stalled while tools remain open within the wall-cap', async () => {
    const guard = new ProgressGuard('task-worker', {
      progressWindowMs: 25,
      stalledMs: 50,
      longRunningToolCapMs: 10_000
    })
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
  })

  it('emits stalled after zero-progress windows accumulate', async () => {
    const guard = new ProgressGuard('conversation', {
      progressWindowMs: 20,
      stalledMs: 40
    })
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
  })

  it('open tools stop suppressing stall after the absolute wall-cap (C.2 hole)', async () => {
    assert.equal(longRunningToolCapMs(30), 30)
    const guard = new ProgressGuard('task-worker', {
      progressWindowMs: 20,
      stalledMs: 40,
      longRunningToolCapMs: 30
    })
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
  })

  it('text activity within the wall-cap still keeps the turn alive', async () => {
    const guard = new ProgressGuard('task-worker', {
      progressWindowMs: 30,
      stalledMs: 80,
      longRunningToolCapMs: 10_000
    })
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
  })

  it('does not treat provider_event and heartbeat liveness as semantic progress', async () => {
    const guard = new ProgressGuard('planner', {
      progressWindowMs: 25,
      stalledMs: 50
    })
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
    assert.equal(stalled, true)
    guard.dispose()
  })
})
