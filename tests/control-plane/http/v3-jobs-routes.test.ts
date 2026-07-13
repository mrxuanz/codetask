import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createJobsRoutes } from '../../../src/server/http/v3/jobs-routes'
import type { JobCommandService } from '@shared/contracts/control-plane'
import type { JobQueryService } from '../../../src/server/application/job-query-service'

const noopCommandService: JobCommandService = {
  async requestPause() {
    throw new Error('not used')
  },
  async continueJob() {
    throw new Error('not used')
  },
  async cancelJob() {
    throw new Error('not used')
  },
  async restartExecution() {
    throw new Error('not used')
  },
  async acknowledgePause() {
    throw new Error('not used')
  },
  async checkpointTask() {
    throw new Error('not used')
  },
  async failPauseCheckpoint() {
    throw new Error('not used')
  },
  async interruptRun() {
    throw new Error('not used')
  }
}

function makeQueryService(overrides?: Partial<JobQueryService>): JobQueryService {
  return {
    getJob: () => null,
    listJobs: () => [],
    getTaskJob: async () => null,
    listTaskJobs: async () => ({ jobs: [], total: 0 }),
    ...overrides
  }
}

describe('V3 jobs routes query snapshots', () => {
  it('omits ETag for legacy-only detail fallback without stateRevision', async () => {
    const routes = createJobsRoutes(
      noopCommandService,
      makeQueryService({
        getTaskJob: async () => ({
          id: 'job-1',
          threadId: 'thread-1',
          draftMessageId: 'draft-1',
          title: 'Job 1',
          summary: '',
          status: 'failed',
          planProgress: {
            phase: 'idle',
            status: 'pending',
            contextsRegistered: 0,
            contextsTotal: 0
          },
          taskProgress: {
            phase: 'idle',
            status: 'pending',
            currentIndex: 0,
            total: 0,
            tasks: []
          },
          abilities: [],
          planRevision: null,
          draftConfirmedAt: null,
          planConfirmedAt: null,
          designSessionId: null,
          snapshotDraftRevision: null,
          snapshotPlanRevision: null,
          snapshotManifestRevision: null,
          createdAt: 1,
          updatedAt: 2
        })
      })
    )

    const response = await routes.getJob(
      { headers: {}, params: { id: 'job-1' } },
      { username: 'u1', requestId: 'r1' }
    )

    assert.equal(response.status, 200)
    assert.equal(response.headers, undefined)
  })

  it('passes list query params through to task snapshot query', async () => {
    let seen:
      | {
          status?: string
          page?: number
          limit?: number
          q?: string
          projectId?: string
        }
      | undefined

    const routes = createJobsRoutes(
      noopCommandService,
      makeQueryService({
        listTaskJobs: async (_actor, options) => {
          seen = options
          return { jobs: [], total: 0 }
        }
      })
    )

    const response = await routes.listJobs(
      {
        headers: {},
        params: {},
        query: {
          status: 'failed',
          page: '3',
          limit: '25',
          q: 'worker',
          projectId: 'project-1'
        }
      },
      { username: 'u1', requestId: 'r1' }
    )

    assert.equal(response.status, 200)
    assert.deepEqual(seen, {
      status: 'failed',
      page: 3,
      limit: 25,
      q: 'worker',
      projectId: 'project-1'
    })
  })
})
