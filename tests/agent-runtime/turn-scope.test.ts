import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { TurnError } from '../../src/shared/turn-errors/turn-error.ts'
import {
  TurnScope,
  assertRoleTurnReply,
  partialCompletedChunk,
  recordAcpToolCallActivity,
  recordOpencodeToolPartActivity
} from '../../src/server/agent-runtime/turn-scope'
import { ProgressGuard } from '../../src/server/agent-runtime/progress-guard'

describe('turn-scope', () => {
  it('process-bound races prompt against process exit without idle timers', async () => {
    const turnScope = new TurnScope({
      role: 'task-worker',
      processExit: new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('child exited')), 40)
      })
    })
    turnScope.arm()

    await assert.rejects(
      () =>
        turnScope.race(
          new Promise<string>((resolve) => {
            setTimeout(() => resolve('late'), 200)
          })
        ),
      (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.match(error.message, /child exited/)
        return true
      }
    )

    turnScope.dispose()
  })

  it('process-bound allows long prompts while child stays alive', async () => {
    const turnScope = new TurnScope({
      role: 'task-worker',
      processExit: new Promise<never>(() => {
        // never resolves
      })
    })
    turnScope.arm()

    const winner = await turnScope.race(
      new Promise<string>((resolve) => {
        setTimeout(() => resolve('ok'), 50)
      })
    )
    assert.equal(winner, 'ok')
    turnScope.dispose()
  })

  it('skips noFirstSignal when processExit is provided', async () => {
    const turnScope = new TurnScope({
      role: 'conversation',
      processExit: new Promise<never>(() => {})
    })
    turnScope.arm()

    const winner = await turnScope.race(
      new Promise<string>((resolve) => {
        setTimeout(() => resolve('ok'), 150)
      })
    )
    assert.equal(winner, 'ok')
    turnScope.dispose()
  })

  it('skips noFirstSignal for conversation without processExit', async () => {
    const turnScope = new TurnScope({
      role: 'conversation',
      onCancel: async () => {}
    })
    turnScope.arm()

    const winner = await turnScope.race(
      new Promise<string>((resolve) => {
        setTimeout(() => resolve('ok'), 150)
      })
    )
    assert.equal(winner, 'ok')
    turnScope.dispose()
  })

  it('emits partial completed only after grace cancel with reply', () => {
    assert.equal(
      partialCompletedChunk({
        reply: 'partial output',
        runtimeSessionId: 'sess-1',
        graceCancelled: true
      })?.partial,
      true
    )
    assert.equal(
      partialCompletedChunk({
        reply: '',
        runtimeSessionId: 'sess-1',
        graceCancelled: true
      }),
      null
    )
  })

  it('assertRoleTurnReply allows partial worker replies', () => {
    assert.doesNotThrow(() =>
      assertRoleTurnReply({
        role: 'task-worker',
        reply: 'partial',
        providerLabel: 'Codex',
        partial: true
      })
    )
    assert.throws(() =>
      assertRoleTurnReply({
        role: 'task-worker',
        reply: '   ',
        providerLabel: 'Codex'
      })
    )
  })

  it('throttles onKeepAlive to about 60s', async () => {
    const calls: number[] = []
    const turnScope = new TurnScope({
      role: 'task-worker',
      processExit: new Promise<never>(() => {}),
      onKeepAlive: () => {
        calls.push(Date.now())
      }
    })
    turnScope.arm()
    turnScope.recordProgress('text_delta')
    turnScope.recordProgress('text_delta')
    assert.equal(calls.length, 1)
    turnScope.dispose()
  })

  it('progress guard stalled triggers grace cancel', async () => {
    const prevWindow = process.env.CODETASK_TURN_PROGRESS_WINDOW_MS
    const prevStalled = process.env.CODETASK_TURN_STALLED_MS
    process.env.CODETASK_TURN_PROGRESS_WINDOW_MS = '20'
    process.env.CODETASK_TURN_STALLED_MS = '40'

    const prevGrace = process.env.CODETASK_TURN_SOFT_GRACE_MS
    process.env.CODETASK_TURN_SOFT_GRACE_MS = '10'

    try {
      const guard = new ProgressGuard('conversation')
      const turnScope = new TurnScope({
        role: 'conversation',
        progressGuard: guard,
        onCancel: async () => {}
      })
      turnScope.arm()

      await assert.rejects(
        () =>
          turnScope.race(
            new Promise<string>((resolve) => {
              setTimeout(() => resolve('late'), 500)
            })
          ),
        (error: unknown) => {
          assert.ok(error instanceof TurnError)
          assert.equal(error.code, 'turn.timed_out')
          return true
        }
      )
      assert.equal(turnScope.graceCancelled, true)
      turnScope.dispose()
    } finally {
      if (prevGrace === undefined) delete process.env.CODETASK_TURN_SOFT_GRACE_MS
      else process.env.CODETASK_TURN_SOFT_GRACE_MS = prevGrace
      if (prevWindow === undefined) delete process.env.CODETASK_TURN_PROGRESS_WINDOW_MS
      else process.env.CODETASK_TURN_PROGRESS_WINDOW_MS = prevWindow
      if (prevStalled === undefined) delete process.env.CODETASK_TURN_STALLED_MS
      else process.env.CODETASK_TURN_STALLED_MS = prevStalled
    }
  })

  it('recordOpencodeToolPartActivity tracks running tools without double-counting', () => {
    const guard = new ProgressGuard('task-worker')
    const turnScope = new TurnScope({
      role: 'task-worker',
      progressGuard: guard
    })
    const openToolIds = new Set<string>()

    recordOpencodeToolPartActivity(
      {
        type: 'tool',
        id: 'part-1',
        callID: 'call-1',
        tool: 'bash',
        state: { status: 'running', title: 'npm run dev', input: { command: 'npm run dev' } }
      },
      turnScope,
      openToolIds
    )
    recordOpencodeToolPartActivity(
      {
        type: 'tool',
        id: 'part-1',
        callID: 'call-1',
        tool: 'bash',
        state: { status: 'running', title: 'npm run dev', input: { command: 'npm run dev' } }
      },
      turnScope,
      openToolIds
    )
    assert.equal(openToolIds.has('call-1'), true)

    recordOpencodeToolPartActivity(
      {
        type: 'tool',
        id: 'part-1',
        callID: 'call-1',
        tool: 'bash',
        state: { status: 'completed', title: 'npm run dev', input: { command: 'npm run dev' } }
      },
      turnScope,
      openToolIds
    )
    assert.equal(openToolIds.size, 0)
    turnScope.dispose()
  })

  it('recordAcpToolCallActivity tracks tool_call lifecycle', () => {
    const guard = new ProgressGuard('task-worker')
    const turnScope = new TurnScope({
      role: 'task-worker',
      progressGuard: guard
    })
    const openToolIds = new Set<string>()

    recordAcpToolCallActivity(
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'tc-1',
        status: 'in_progress',
        title: 'Running npm test'
      },
      turnScope,
      openToolIds
    )
    assert.equal(openToolIds.has('tc-1'), true)

    recordAcpToolCallActivity(
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tc-1',
        status: 'in_progress',
        title: 'Running npm test'
      },
      turnScope,
      openToolIds
    )
    assert.equal(openToolIds.size, 1)

    recordAcpToolCallActivity(
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tc-1',
        status: 'completed'
      },
      turnScope,
      openToolIds
    )
    assert.equal(openToolIds.size, 0)
    turnScope.dispose()
  })
})
