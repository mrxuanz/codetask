import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createDraft, asDraftId } from '../../../src/server/core/domain/drafts/index.ts'
import { confirmDraftCommand } from '../../../src/server/core/application/commands/confirm-draft.ts'
import { InMemoryUnitOfWork } from '../../../src/server/adapters/memory/in-memory-uow.ts'
import { createTestApplication } from '../../helpers/core/create-application.ts'

describe('outbox unit of work', () => {
  it('collects events during run and publishes on commit', async () => {
    const app = createTestApplication()
    const draft = createDraft({
      id: asDraftId('draft-outbox'),
      projectId: 'proj-1',
      threadId: 'thread-1'
    })
    await app.drafts.save(draft)

    assert.equal(app.eventPublisher.published.length, 0)

    const result = await confirmDraftCommand(app, {
      draftId: 'draft-outbox',
      expectedRevision: 1,
      idempotencyKey: 'outbox-1',
      payloadHash: 'h1',
      actorId: 'user-1'
    })
    assert.equal(result.ok, true)
    assert.equal(app.eventPublisher.published.length, 1)
    assert.equal(app.eventPublisher.published[0]?.type, 'draft.confirmed')
    assert.equal(app.eventPublisher.published[0]?.aggregateId, 'draft-outbox')
  })

  it('discards events when work throws before commit', async () => {
    const app = createTestApplication()
    const uow = app.unitOfWork as InMemoryUnitOfWork

    await assert.rejects(async () => {
      await uow.run(async (tx) => {
        tx.enqueueEvent({ type: 'should.not.publish', aggregateId: 'x' })
        assert.equal(uow.pendingEvents.length, 1)
        throw new Error('boom')
      })
    }, /boom/)

    assert.equal(app.eventPublisher.published.length, 0)
    assert.equal(uow.pendingEvents.length, 0)
  })
})
