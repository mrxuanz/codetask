import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createDraft, asDraftId, confirmDraft } from '../../../src/server/core/domain/drafts/index.ts'
import { createJob, asJobId } from '../../../src/server/core/domain/jobs/types.ts'
import { patchDraftCommand } from '../../../src/server/core/application/commands/patch-draft.ts'
import { confirmDraftSectionCommand } from '../../../src/server/core/application/commands/confirm-draft-section.ts'
import { unlockDraftCommand } from '../../../src/server/core/application/commands/unlock-draft.ts'
import { createTestApplication } from '../../helpers/core/create-application.ts'

describe('draft writer commands', () => {
  it('patchDraftCommand updates content and payload while collecting', async () => {
    const app = createTestApplication()
    const draft = createDraft({
      id: asDraftId('draft-patch'),
      projectId: 'proj-1',
      threadId: 'thread-1',
      content: 'before'
    })
    await app.drafts.save(draft)

    const result = await patchDraftCommand(app, {
      draftId: 'draft-patch',
      expectedRevision: 1,
      content: 'after',
      payload: { wizardPhase: 'draft_review', sections: { summary: { content: 's' } } },
      idempotencyKey: 'patch-1',
      payloadHash: 'h1',
      actorId: 'u1'
    })
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.value.draft.content, 'after')
    assert.equal(result.value.draft.payload?.wizardPhase, 'draft_review')
    assert.equal(result.value.draft.revision, 2)
  })

  it('confirmDraftSectionCommand locks a section', async () => {
    const app = createTestApplication()
    await app.drafts.save(
      createDraft({
        id: asDraftId('draft-section'),
        projectId: 'proj-1',
        threadId: 'thread-1'
      })
    )

    const result = await confirmDraftSectionCommand(app, {
      draftId: 'draft-section',
      expectedRevision: 1,
      sectionKey: 'acceptance',
      idempotencyKey: 'sec-1',
      payloadHash: 'h1',
      actorId: 'u1'
    })
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.value.draft.payload?.sections?.acceptance?.locked, true)
  })

  it('unlockDraftCommand rolls confirmed → collecting and cancels linked job', async () => {
    const app = createTestApplication()
    const collecting = createDraft({
      id: asDraftId('draft-unlock'),
      projectId: 'proj-1',
      threadId: 'thread-1',
      payload: { planId: 'job-linked' }
    })
    const confirmed = confirmDraft(collecting)
    await app.drafts.save(confirmed)
    await app.jobs.save(
      createJob({
        id: 'job-linked',
        status: 'queued',
        planRevision: 1,
        executionGeneration: 1,
        stateRevision: 0
      })
    )

    const result = await unlockDraftCommand(
      { ...app, jobs: app.jobs },
      {
        draftId: 'draft-unlock',
        expectedRevision: confirmed.revision,
        idempotencyKey: 'unlock-1',
        payloadHash: 'h1',
        actorId: 'u1'
      }
    )
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.value.draft.status, 'collecting')
    assert.equal(result.value.draft.payload?.planId, null)

    const job = await app.jobs.get('job-linked')
    assert.equal(job?.status, 'cancelled')
    assert.equal(job?.id, asJobId('job-linked'))
  })

  it('unlockDraftCommand works domain-only when jobs port omitted', async () => {
    const app = createTestApplication()
    const confirmed = confirmDraft(
      createDraft({
        id: asDraftId('draft-unlock-dom'),
        projectId: 'proj-1',
        threadId: 'thread-1',
        payload: { planId: 'missing-job' }
      })
    )
    await app.drafts.save(confirmed)

    const result = await unlockDraftCommand(
      {
        drafts: app.drafts,
        unitOfWork: app.unitOfWork,
        idempotency: app.idempotency
      },
      {
        draftId: 'draft-unlock-dom',
        expectedRevision: confirmed.revision,
        idempotencyKey: 'unlock-2',
        payloadHash: 'h2',
        actorId: 'u1'
      }
    )
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.value.draft.status, 'collecting')
    assert.equal(result.value.draft.payload?.planId, null)
  })
})
