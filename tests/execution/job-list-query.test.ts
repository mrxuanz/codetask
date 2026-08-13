import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { JobDetail } from '@codetask/contracts'
import type { JobRecord } from '../../packages/server-core/src/modules/execution/job/domain/job-state.ts'
import { QueryJobService } from '../../packages/server-core/src/modules/execution/job/application/query-job.ts'

function record(id: string, state: JobRecord['state'], title: string, summary: string): JobRecord {
  const now = Date.now()
  return {
    id,
    submissionId: `submission-${id}`,
    submissionHash: `hash-${id}`,
    idempotencyKey: `key-${id}`,
    actorId: 'alice',
    projectId: 'project-1',
    sourceDraftId: `draft-${id}`,
    sourcePlanningSessionId: `planning-${id}`,
    title,
    summary,
    workspaceRoot: '/workspace',
    canonicalWorkspaceRoot: '/workspace',
    state,
    stateRevision: 1,
    controlIntent: 'none',
    executionGeneration: 1,
    currentRunId: null,
    suspensionKind: null,
    recoveryReason: null,
    lastErrorJson: null,
    queuedAt: now,
    startedAt: null,
    terminalAt: state === 'succeeded' ? now : null,
    createdAt: now,
    updatedAt: now
  }
}

function toDetail(job: JobRecord, queuePosition: number | null): JobDetail {
  return {
    id: job.id,
    title: job.title,
    summary: job.summary,
    state: job.state,
    stateRevision: job.stateRevision,
    controlIntent: job.controlIntent,
    executionGeneration: job.executionGeneration,
    projectId: job.projectId,
    actorId: job.actorId,
    workspaceRoot: job.workspaceRoot,
    queuedAt: job.queuedAt ? new Date(job.queuedAt).toISOString() : null,
    startedAt: null,
    terminalAt: job.terminalAt ? new Date(job.terminalAt).toISOString() : null,
    availableActions: [],
    recoveryReason: job.recoveryReason,
    sourceDraftId: job.sourceDraftId,
    sourcePlanningSessionId: job.sourcePlanningSessionId,
    currentRunId: job.currentRunId,
    suspensionKind: job.suspensionKind,
    queuePosition,
    createdAt: new Date(job.createdAt).toISOString(),
    updatedAt: new Date(job.updatedAt).toISOString()
  }
}

describe('QueryJobService.listPage', () => {
  const rows = [
    record('job-1', 'succeeded', 'Release Website', 'Production release'),
    record('job-2', 'running', 'Build API', 'Hono service'),
    record('job-3', 'succeeded', 'Write Docs', 'API reference')
  ]
  const jobs = {
    listPageByActor(input: {
      actorId: string
      state: JobRecord['state'] | null
      query: string
      page: number
      limit: number
    }) {
      assert.equal(input.actorId, 'alice')
      const matches = rows.filter(
        (row) =>
          (!input.state || row.state === input.state) &&
          (!input.query || `${row.title}\n${row.summary}`.toLowerCase().includes(input.query))
      )
      const start = (input.page - 1) * input.limit
      return { jobs: matches.slice(start, start + input.limit), total: matches.length }
    },
    toDetail
  }
  const queue = { getPosition: () => null }
  const service = new QueryJobService(jobs as never, queue as never, {} as never, {} as never)
  const actor = { userId: 'alice', sessionId: 'session-1' }

  it('maps the UI completed filter to succeeded and returns a real total', () => {
    const result = service.listPage(actor, { status: 'completed', page: 1, limit: 1 })
    assert.equal(result.total, 2)
    assert.equal(result.jobs.length, 1)
    assert.equal(result.jobs[0]?.state, 'succeeded')
    assert.equal(result.page, 1)
    assert.equal(result.limit, 1)
  })

  it('searches title and summary before applying pagination', () => {
    const result = service.listPage(actor, { query: 'api', page: 1, limit: 10 })
    assert.equal(result.total, 2)
    assert.deepEqual(
      result.jobs.map((job) => job.id),
      ['job-2', 'job-3']
    )
  })

  it('rejects unsupported filters and invalid pagination', () => {
    assert.throws(() => service.listPage(actor, { status: 'unknown' }), /Unsupported job status/)
    assert.throws(() => service.listPage(actor, { page: 0 }), /positive integer/)
    assert.throws(() => service.listPage(actor, { limit: 201 }), /between 1 and 200/)
  })
})
