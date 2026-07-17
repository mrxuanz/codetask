import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  TurnScope,
  assertRoleTurnReply,
  partialCompletedChunk,
  recordAcpToolCallActivity,
  recordOpencodeToolPartActivity
} from '../../src/server/agent-runtime/turn-scope'
import { ProgressGuard } from '../../src/server/agent-runtime/progress-guard'
import { createTurnError } from '../../src/shared/turn-errors.ts'

describe('turn-scope', () => {
  it('preserves an explicit external abort reason', async () => {
    const controller = new AbortController()
    const reason = createTurnError('task.evidence_timeout', { params: { taskId: 't1' } })
    const turnScope = new TurnScope({
      role: 'task-worker',
      externalSignal: controller.signal
    })
    turnScope.arm()

    const raced = turnScope.race(new Promise<never>(() => {}))
    controller.abort(reason)

    await assert.rejects(raced, (error: unknown) => error === reason)
    turnScope.dispose()
  })

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

  it('aborts the provider turn when lease keepalive fails', async () => {
    const lost = Object.assign(new Error('lease lost'), { code: 'workspace.lease_lost' })
    const turnScope = new TurnScope({
      role: 'conversation',
      onKeepAlive: () => {
        throw lost
      }
    })
    turnScope.arm()
    turnScope.recordProgress('text_delta')
    await assert.rejects(
      () => turnScope.race(new Promise<never>(() => {})),
      (error: unknown) => error === lost
    )
  })

  it('progress guard reports suspected stall without cancelling the turn', async () => {
    const guard = new ProgressGuard('conversation', {
      progressWindowMs: 20,
      stalledMs: 40
    })
    try {
      const turnScope = new TurnScope({
        role: 'conversation',
        progressGuard: guard
      })
      turnScope.arm()

      const result = await turnScope.race(
        new Promise<string>((resolve) => {
          setTimeout(() => resolve('still-running'), 120)
        })
      )
      assert.equal(result, 'still-running')
      assert.equal(turnScope.suspectedStall, true)
      assert.equal(turnScope.graceCancelled, false)
      turnScope.dispose()
    } finally {
      guard.dispose()
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
