import assert from 'node:assert/strict'
import test from 'node:test'
import { dispatchPlannerToolForTests } from '../../src/server/planner/mcp/handler'
import {
  registerPlannerMcpSession,
  unregisterPlannerMcpSession,
  type PlannerMcpSession
} from '../../src/server/planner/mcp/session'
import { buildPlanOutlineArgs } from '../helpers/fixtures'

function createSession(id: string): PlannerMcpSession {
  return {
    sessionId: id,
    jobId: 'job-outline-protocol',
    threadId: 'thread-outline-protocol',
    runId: 'run-outline-protocol',
    ownerKind: 'thread_job',
    ownerId: 'job-outline-protocol',
    allowedAbilityCodes: ['project-setup', 'frontend-implementation', 'testing-validation'],
    validReferenceIds: [],
    taskContexts: new Map(),
    planOutline: null
  }
}

test('planner protocol locks outline before accepting task contexts', async () => {
  const session = createSession('planner-outline-order')
  let outlineWrites = 0
  let contextWrites = 0
  session.onPlanOutlineRegistered = async () => {
    outlineWrites += 1
  }
  session.onTaskContextRegistered = async () => {
    contextWrites += 1
  }
  registerPlannerMcpSession(session)

  try {
    const context = {
      milestone: 1,
      slice: 1,
      task: 1,
      taskTitle: '项目初始化',
      content: 'Detailed setup context'
    }
    await assert.rejects(
      dispatchPlannerToolForTests(session.sessionId, 'register_task_context', context),
      /register_plan_outline/
    )

    await dispatchPlannerToolForTests(
      session.sessionId,
      'register_plan_outline',
      buildPlanOutlineArgs()
    )
    assert.equal(outlineWrites, 1)
    assert.equal(session.taskContexts.size, 0)

    await assert.rejects(
      dispatchPlannerToolForTests(session.sessionId, 'register_task_context', {
        ...context,
        taskTitle: 'Drifted title'
      }),
      /taskTitle mismatch/
    )
    await assert.rejects(
      dispatchPlannerToolForTests(session.sessionId, 'register_task_context', {
        ...context,
        task: 99
      }),
      /does not exist in the locked plan outline/
    )

    await dispatchPlannerToolForTests(session.sessionId, 'register_task_context', context)
    await dispatchPlannerToolForTests(session.sessionId, 'register_task_context', context)
    assert.equal(session.taskContexts.size, 1)
    assert.equal(contextWrites, 1)

    await assert.rejects(
      dispatchPlannerToolForTests(session.sessionId, 'register_task_context', {
        ...context,
        content: 'Conflicting content'
      }),
      /use update_task_context/
    )
    await assert.rejects(
      dispatchPlannerToolForTests(session.sessionId, 'finalize_plan', {}),
      /missing task context for 2 task\(s\)/
    )
    await assert.rejects(
      dispatchPlannerToolForTests(session.sessionId, 'finalize_plan', { unexpected: true }),
      /does not accept arguments/
    )
  } finally {
    unregisterPlannerMcpSession(session.sessionId)
  }
})

test('accepted outline is immutable and identical retries are idempotent', async () => {
  const session = createSession('planner-outline-lock')
  let writes = 0
  session.onPlanOutlineRegistered = async () => {
    writes += 1
  }
  registerPlannerMcpSession(session)

  try {
    const outline = buildPlanOutlineArgs()
    await dispatchPlannerToolForTests(session.sessionId, 'register_plan_outline', outline)
    await dispatchPlannerToolForTests(session.sessionId, 'register_plan_outline', outline)
    assert.equal(writes, 1)

    const changed = buildPlanOutlineArgs()
    changed.milestones[0]!.title = 'Changed title'
    await assert.rejects(
      dispatchPlannerToolForTests(session.sessionId, 'register_plan_outline', changed),
      /already locked/
    )
  } finally {
    unregisterPlannerMcpSession(session.sessionId)
  }
})

test('concurrent calls are serialized in protocol order', async () => {
  const session = createSession('planner-outline-concurrency')
  const writes: string[] = []
  session.onPlanOutlineRegistered = async () => {
    await new Promise((resolve) => setTimeout(resolve, 10))
    writes.push('outline')
  }
  session.onTaskContextRegistered = async () => {
    writes.push('context')
  }
  registerPlannerMcpSession(session)

  try {
    await Promise.all([
      dispatchPlannerToolForTests(
        session.sessionId,
        'register_plan_outline',
        buildPlanOutlineArgs()
      ),
      dispatchPlannerToolForTests(session.sessionId, 'register_task_context', {
        milestone: 1,
        slice: 1,
        task: 1,
        taskTitle: '项目初始化',
        content: 'Detailed setup context'
      })
    ])
    assert.deepEqual(writes, ['outline', 'context'])
  } finally {
    unregisterPlannerMcpSession(session.sessionId)
  }
})
