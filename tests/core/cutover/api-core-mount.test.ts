import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  createApplication,
  type ApplicationHandle
} from '../../../src/server/composition/create-application.ts'
import { mountCoreHttpRoutes } from '../../../src/server/interfaces/http/hono-mount.ts'
import { createJob } from '../../../src/server/core/domain/jobs/types.ts'

describe('api core mount cutover', () => {
  it('createApplication memory kind and close()', () => {
    const app = createApplication({ mode: 'memory' })
    assert.equal(app.kind, 'memory')
    assert.equal(typeof app.close, 'function')
    app.close()
  })

  it('GET /jobs/:id and POST pause via Hono mount', async () => {
    const app: ApplicationHandle = createApplication({ mode: 'memory' })
    try {
      const job = createJob({
        id: 'job-core-mount-1',
        status: 'queued',
        stateRevision: 0,
        executionGeneration: 1,
        planRevision: 1
      })
      await app.jobs.save(job)

      const hono = mountCoreHttpRoutes(app)

      const getRes = await hono.request('/jobs/job-core-mount-1', {
        method: 'GET',
        headers: {
          Authorization: 'Bearer test-user'
        }
      })
      assert.equal(getRes.status, 200)
      const getBody = (await getRes.json()) as {
        success: boolean
        data: { job: { id: string; status: string; stateRevision: number } }
      }
      assert.equal(getBody.success, true)
      assert.equal(getBody.data.job.id, 'job-core-mount-1')
      // Legacy-shaped: domain queued → pending
      assert.equal(getBody.data.job.status, 'pending')
      assert.equal(getBody.data.job.stateRevision, 0)

      const pauseRes = await hono.request('/jobs/job-core-mount-1/pause', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-user',
          'Idempotency-Key': 'idem-pause-core-1',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ expectedRevision: 0 })
      })
      assert.equal(pauseRes.status, 200)
      const pauseBody = (await pauseRes.json()) as {
        success: boolean
        data: { job: { status: string; stateRevision: number } }
      }
      assert.equal(pauseBody.success, true)
      assert.equal(pauseBody.data.job.status, 'paused')
      assert.equal(pauseBody.data.job.stateRevision, 1)

      const health = await hono.request('/health')
      assert.equal(health.status, 200)
      const healthBody = (await health.json()) as {
        success: boolean
        data: { kernel: string; kind?: string }
      }
      assert.equal(healthBody.success, true)
      assert.equal(healthBody.data.kernel, 'new-core')
      assert.equal(healthBody.data.kind, 'memory')
    } finally {
      app.close()
    }
  })
})
