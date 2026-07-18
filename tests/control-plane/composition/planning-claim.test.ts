import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { getControlPlaneServices } from '../../../src/server/application/control-plane-services'
import {
  bootAuthoritativeRuntime,
  countOpenSlots,
  getSqliteClient,
  seedControlJob,
  sleep,
  withCompositionContext
} from './fixtures'

describe('composition: planning claim without planner provider (D03)', () => {
  it('does not leave planning_running zombie state or held slots', async () => {
    await withCompositionContext(
      {
        generation: 'v3_authoritative',
        seed(db) {
          seedControlJob(db, {
            jobId: 'job-plan-1',
            username: 'u1',
            state: 'planning_queued',
            stateRevision: 1
          })
        }
      },
      async (ctx) => {
        await bootAuthoritativeRuntime(ctx, { startScheduler: true })
        await sleep(1_500)

        const db = getSqliteClient(ctx)
        const { queryService } = getControlPlaneServices(ctx)
        const job = queryService.getJob('job-plan-1', { username: 'u1' })
        assert.ok(job, 'seeded control job must be readable')

        assert.notEqual(
          job.state,
          'planning_running',
          'without planner provider planning must not be claimed into planning_running'
        )
        assert.equal(
          countOpenSlots(db),
          0,
          'planning claim must not leak resource slots without a real planner runtime'
        )
        assert.equal(job.activeRunId, null)
      }
    )
  })
})
