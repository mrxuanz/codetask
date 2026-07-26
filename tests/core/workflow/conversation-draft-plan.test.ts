import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { asPlanNodeId } from '../../../src/server/core/domain/plans/index.ts'
import { withThreadPointers } from '../../../src/server/core/domain/conversation/index.ts'
import {
  conversationTurnWork,
  freezeDraftWork,
  planValidateWork,
  commitPlanTreeProposal
} from '../../../src/server/core/application/workflows/index.ts'
import { confirmPlanCommand } from '../../../src/server/core/application/commands/confirm-plan.ts'
import { enqueueJobCommand } from '../../../src/server/core/application/commands/enqueue-job.ts'
import {
  getDraftQuery,
  getPlanQuery,
  getThreadQuery
} from '../../../src/server/core/application/queries/index.ts'
import { runFakePlanner } from '../../../src/server/core/skills/builtins/index.ts'
import { createTestApplication } from '../../helpers/core/create-application.ts'

describe('Conversation → Draft → Plan → Confirm → Queue', () => {
  it('runs the full workflow with in-memory ports and Fake Planner', async () => {
    const app = createTestApplication()
    const signal = new AbortController().signal

    const turn = await conversationTurnWork(
      app,
      {
        threadId: 'thr-1',
        projectId: 'prj-1',
        ownerUserId: 'user-1',
        message: 'Build a settings page with dark mode',
        createTaskMode: true,
        signal
      },
      {
        actorId: 'user-1',
        requestId: 'req-1',
        idempotencyKey: 'turn-1',
        signal
      }
    )
    assert.equal(turn.ok, true)
    if (!turn.ok) return
    assert.equal(turn.value.status, 'completed')
    assert.ok(turn.value.draft)
    assert.equal(turn.value.draft?.status, 'collecting')

    const draftId = turn.value.draft!.id
    const threadProj = await getThreadQuery(app, { threadId: 'thr-1' })
    assert.equal(threadProj.ok, true)
    if (!threadProj.ok) return
    assert.equal(threadProj.value.draftId, draftId)

    const frozen = await freezeDraftWork(app, {
      draftId,
      expectedRevision: turn.value.draft!.revision,
      signal
    })
    assert.equal(frozen.ok, true)
    if (!frozen.ok) return
    assert.equal(frozen.value.draft.status, 'confirmed')

    const draftProj = await getDraftQuery(app, { draftId })
    assert.equal(draftProj.ok, true)
    if (!draftProj.ok) return
    assert.equal(draftProj.value.status, 'confirmed')

    const proposal = runFakePlanner({
      draftId,
      content: frozen.value.draft.content
    })
    const committed = await commitPlanTreeProposal(app, {
      proposal,
      threadId: 'thr-1',
      draftId
    })
    assert.equal(committed.ok, true)
    if (!committed.ok) return
    assert.equal(committed.value.plan.status, 'editing')
    assert.ok(committed.value.plan.nodes.some((n) => n.kind === 'task'))

    const planId = committed.value.plan.id
    await app.threads.save(
      withThreadPointers(turn.value.thread, { planId })
    )

    const validated = await planValidateWork(app, {
      planId,
      markInReview: true,
      expectedRevision: Number(committed.value.plan.revision),
      signal
    })
    assert.equal(validated.ok, true)
    if (!validated.ok) return
    assert.equal(validated.value.plan.status, 'in_review')

    const confirmed = await confirmPlanCommand(app, {
      planId,
      expectedRevision: Number(validated.value.plan.revision),
      idempotencyKey: 'confirm-plan-1',
      payloadHash: 'plan-confirm-hash'
    })
    assert.equal(confirmed.ok, true)
    if (!confirmed.ok) return
    assert.equal(confirmed.value.plan.status, 'confirmed')

    const queued = await enqueueJobCommand(app, {
      planId,
      expectedPlanRevision: Number(confirmed.value.plan.revision),
      idempotencyKey: 'enqueue-1',
      payloadHash: 'enqueue-hash'
    })
    assert.equal(queued.ok, true)
    if (!queued.ok) return
    assert.equal(queued.value.job.status, 'queued')

    const planProj = await getPlanQuery(app, { planId })
    assert.equal(planProj.ok, true)
    if (!planProj.ok) return
    assert.equal(planProj.value.status, 'confirmed')
  })

  it('AbortSignal aborts conversation turn work', async () => {
    const app = createTestApplication()
    const controller = new AbortController()
    controller.abort(new Error('client cancelled'))

    const result = await conversationTurnWork(app, {
      threadId: 'thr-abort',
      projectId: 'prj-1',
      ownerUserId: 'user-1',
      message: 'hello',
      createTaskMode: true,
      signal: controller.signal
    })
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.error.code, 'work.aborted')
  })

  it('rejects mutating a confirmed draft via conversation turn', async () => {
    const app = createTestApplication()
    const first = await conversationTurnWork(app, {
      threadId: 'thr-2',
      projectId: 'prj-1',
      ownerUserId: 'user-1',
      message: 'initial',
      createTaskMode: true,
      draftId: 'draft-locked'
    })
    assert.equal(first.ok, true)
    if (!first.ok) return

    const frozen = await freezeDraftWork(app, {
      draftId: 'draft-locked',
      expectedRevision: first.value.draft!.revision
    })
    assert.equal(frozen.ok, true)

    const second = await conversationTurnWork(app, {
      threadId: 'thr-2',
      projectId: 'prj-1',
      ownerUserId: 'user-1',
      message: 'should fail',
      createTaskMode: true,
      draftId: 'draft-locked'
    })
    assert.equal(second.ok, false)
    if (second.ok) return
    assert.equal(second.error.code, 'draft.not_collecting')
  })

  it('rejects illegal plan operations in planValidateWork', async () => {
    const app = createTestApplication()
    const proposal = runFakePlanner({ draftId: 'd', content: 'x' })
    const committed = await commitPlanTreeProposal(app, {
      proposal,
      threadId: 'thr-3',
      draftId: 'd',
      planId: 'plan-illegal'
    })
    assert.equal(committed.ok, true)
    if (!committed.ok) return

    const result = await planValidateWork(app, {
      planId: 'plan-illegal',
      expectedRevision: Number(committed.value.plan.revision),
      operations: [
        {
          type: 'remove_node',
          nodeId: asPlanNodeId('missing-node')
        }
      ]
    })
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.error.code, 'plan.node_not_found')
  })
})
