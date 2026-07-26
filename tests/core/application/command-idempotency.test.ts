import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createDraft, asDraftId } from '../../../src/server/core/domain/drafts/index.ts'
import { confirmDraftCommand } from '../../../src/server/core/application/commands/confirm-draft.ts'
import { createTestApplication } from '../../helpers/core/create-application.ts'

describe('command idempotency', () => {
  it('same key + same payload returns cached result without re-transition', async () => {
    const app = createTestApplication()
    const draft = createDraft({
      id: asDraftId('draft-idem'),
      projectId: 'proj-1',
      threadId: 'thread-1',
      content: 'req'
    })
    await app.drafts.save(draft)

    const command = {
      draftId: 'draft-idem',
      expectedRevision: 1,
      idempotencyKey: 'confirm-1',
      payloadHash: 'payload-a',
      actorId: 'user-1'
    }

    const first = await confirmDraftCommand(app, command)
    assert.equal(first.ok, true)
    if (!first.ok) return
    assert.equal(first.value.draft.status, 'confirmed')

    const second = await confirmDraftCommand(app, command)
    assert.equal(second.ok, true)
    if (!second.ok) return
    assert.deepEqual(second.value, first.value)
  })

  it('same key + different payload returns idempotency conflict', async () => {
    const app = createTestApplication()
    const draft = createDraft({
      id: asDraftId('draft-conflict'),
      projectId: 'proj-1',
      threadId: 'thread-1'
    })
    await app.drafts.save(draft)

    const first = await confirmDraftCommand(app, {
      draftId: 'draft-conflict',
      expectedRevision: 1,
      idempotencyKey: 'confirm-2',
      payloadHash: 'payload-a',
      actorId: 'user-1'
    })
    assert.equal(first.ok, true)

    const second = await confirmDraftCommand(app, {
      draftId: 'draft-conflict',
      expectedRevision: 1,
      idempotencyKey: 'confirm-2',
      payloadHash: 'payload-b',
      actorId: 'user-1'
    })
    assert.equal(second.ok, false)
    if (second.ok) return
    assert.equal(second.error.code, 'idempotency.conflict')
  })
})
