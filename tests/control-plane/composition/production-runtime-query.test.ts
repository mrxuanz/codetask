import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { getControlPlaneServices } from '../../../src/server/application/control-plane-services'
import {
  bootAuthoritativeRuntime,
  seedControlJob,
  withCompositionContext
} from './fixtures'

describe('composition: production runtime query (D01)', () => {
  it('listTaskJobs returns control-plane jobs without legacy snapshots', async () => {
    await withCompositionContext(
      {
        generation: 'v3_authoritative',
        seed(db) {
          seedControlJob(db, { jobId: 'job-1', username: 'u1', state: 'execution_queued' })
        }
      },
      async (ctx) => {
        await bootAuthoritativeRuntime(ctx)
        const { queryService } = getControlPlaneServices(ctx)
        const listed = await queryService.listTaskJobs({ username: 'u1' })
        assert.equal(
          listed.total,
          1,
          'authoritative listTaskJobs must read control_jobs, not empty legacy snapshots'
        )
        assert.equal(listed.jobs[0]?.id, 'job-1')

        const detail = await queryService.getTaskJob('job-1', { username: 'u1' })
        assert.ok(detail, 'authoritative getTaskJob must resolve from control tables')
        assert.equal(detail?.id, 'job-1')
      }
    )
  })
})
