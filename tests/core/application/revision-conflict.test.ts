import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createDraft, asDraftId } from '../../../src/server/core/domain/drafts/index.ts'
import { RevisionConflictError } from '../../../src/server/core/application/ports/repositories.ts'
import { createTestApplication } from '../../helpers/core/create-application.ts'

describe('revision conflict on save', () => {
  it('rejects stale expectedRevision for drafts', async () => {
    const app = createTestApplication()
    const draft = createDraft({
      id: asDraftId('draft-1'),
      projectId: 'proj-1',
      threadId: 'thread-1',
      content: 'hello'
    })
    await app.drafts.save(draft)
    assert.equal(draft.revision, 1)

    const updated = { ...draft, content: 'changed', revision: 2 }
    await assert.rejects(
      () => app.drafts.save(updated, { expectedRevision: 0 }),
      (err: unknown) => {
        assert.ok(err instanceof RevisionConflictError)
        assert.equal(err.code, 'revision.conflict')
        return true
      }
    )

    await app.drafts.save(updated, { expectedRevision: 1 })
    const stored = await app.drafts.get('draft-1')
    assert.equal(stored?.revision, 2)
    assert.equal(stored?.content, 'changed')
  })

  it('rejects stale expectedRevision for jobs', async () => {
    const app = createTestApplication()
    const { createJob } = await import('../../../src/server/core/domain/jobs/index.ts')
    const job = createJob({ id: 'job-1', status: 'queued', stateRevision: 5 })
    await app.jobs.save(job)

    const next = { ...job, status: 'paused' as const, stateRevision: 6 }
    await assert.rejects(
      () => app.jobs.save(next, { expectedRevision: 4 }),
      RevisionConflictError
    )
    await app.jobs.save(next, { expectedRevision: 5 })
    assert.equal((await app.jobs.get('job-1'))?.stateRevision, 6)
  })
})
