import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { Hono } from 'hono'
import {
  createApplication,
  enrichUserJobsFromCore,
  tryCoreJobControl,
  tryCoreJobDelete,
  tryCoreJobSseSnapshot,
  tryMapCoreJobToLegacy,
  type ApplicationHandle
} from '../../../src/server/composition/index.ts'
import { createJob } from '../../../src/server/core/domain/jobs/types.ts'
import { mapJobToLegacy } from '../../../src/server/compatibility/legacy-api-mapper.ts'
import { projectJob } from '../../../src/server/core/application/queries/get-job.ts'

describe('core job control bridge', () => {
  let core: ApplicationHandle | null = null

  afterEach(() => {
    core?.close()
    core = null
  })

  it('tryCoreJobControl get response is shaped via legacy-api-mapper (B1)', async () => {
    core = createApplication({ mode: 'memory' })
    await core.jobs.save(
      createJob({
        id: 'bridge-job-map',
        status: 'queued',
        stateRevision: 0
      })
    )

    const app = new Hono()
    app.get('/:jobId', async (c) => {
      const r = await tryCoreJobControl(c, 'get', c.req.param('jobId'), core!)
      if (!r) return c.json({ bridged: false }, 500)
      return r
    })

    const res = await app.request('/bridge-job-map', {
      headers: { Authorization: 'Bearer u1' }
    })
    assert.equal(res.status, 200)
    const body = (await res.json()) as {
      success: boolean
      data: { job: ReturnType<typeof mapJobToLegacy> }
    }
    assert.equal(body.success, true)
    const expected = mapJobToLegacy(
      projectJob(
        createJob({
          id: 'bridge-job-map',
          status: 'queued',
          stateRevision: 0
        })
      )
    )
    assert.equal(body.data.job.status, expected.status)
    assert.equal(body.data.job.status, 'pending')
    assert.deepEqual([...body.data.job.availableActions], [...expected.availableActions])
    assert.equal(body.data.job.stateRevision, 0)
    assert.ok('planProgress' in body.data.job)
    assert.ok('taskProgress' in body.data.job)
  })

  it('tryCoreJobControl pauses job present in core', async () => {
    core = createApplication({ mode: 'memory' })
    await core.jobs.save(
      createJob({
        id: 'bridge-job-1',
        status: 'queued',
        stateRevision: 0
      })
    )

    const app = new Hono()
    app.post('/:jobId/pause', async (c) => {
      const r = await tryCoreJobControl(c, 'pause', c.req.param('jobId'), core!)
      if (!r) return c.json({ bridged: false }, 500)
      return r
    })

    const res = await app.request('/bridge-job-1/pause', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer u1',
        'Content-Type': 'application/json'
      },
      body: '{}'
    })
    assert.equal(res.status, 200)
    const body = (await res.json()) as {
      success: boolean
      data: { job: { status: string; availableActions: readonly string[] } }
    }
    assert.equal(body.success, true)
    assert.equal(body.data.job.status, 'paused')
    assert.deepEqual([...body.data.job.availableActions], ['continue', 'cancel'])

    // C3: bridged pause is core-authoritative — mutation persists to core store.
    const stored = await core!.jobs.get('bridge-job-1')
    assert.equal(stored?.status, 'paused')
    assert.ok((stored?.stateRevision ?? 0) > 0)
  })

  it('tryCoreJobControl returns null when job missing in core', async () => {
    core = createApplication({ mode: 'memory' })
    const app = new Hono()
    app.post('/:jobId/pause', async (c) => {
      const r = await tryCoreJobControl(c, 'pause', 'missing-job', core!)
      return c.json({ bridged: r !== null })
    })
    const res = await app.request('/missing-job/pause', {
      method: 'POST',
      headers: { Authorization: 'Bearer u1' }
    })
    const body = (await res.json()) as { bridged: boolean }
    assert.equal(body.bridged, false)
  })

  it('enrichUserJobsFromCore replaces DTOs when core has the id (B2)', async () => {
    core = createApplication({ mode: 'memory' })
    await core.jobs.save(
      createJob({
        id: 'list-core-1',
        status: 'running',
        stateRevision: 2
      })
    )

    const legacy = [
      {
        id: 'list-core-1',
        status: 'pending',
        title: 'legacy-title',
        stateRevision: 0
      },
      {
        id: 'list-legacy-only',
        status: 'running',
        title: 'only-legacy',
        stateRevision: 1
      }
    ]

    const enriched = await enrichUserJobsFromCore(legacy, core)
    assert.equal(enriched.length, 2)
    assert.equal(enriched[0]?.id, 'list-core-1')
    assert.equal(enriched[0]?.status, 'running')
    assert.equal(enriched[0]?.stateRevision, 2)
    assert.equal(enriched[0]?.title, 'legacy-title')
    assert.equal(enriched[1]?.id, 'list-legacy-only')
    assert.equal(enriched[1]?.status, 'running')
  })

  it('enrichUserJobsFromCore is identity when core empty (B2)', async () => {
    core = createApplication({ mode: 'memory' })
    const legacy = [{ id: 'a', status: 'pending' as const }]
    const enriched = await enrichUserJobsFromCore(legacy, core)
    assert.deepEqual(enriched, legacy)
  })

  it('tryCoreJobDelete cancels job in core and returns deleted + mapped job (B3)', async () => {
    core = createApplication({ mode: 'memory' })
    await core.jobs.save(
      createJob({
        id: 'del-job-1',
        status: 'queued',
        stateRevision: 0
      })
    )

    const app = new Hono()
    app.delete('/:jobId', async (c) => {
      const r = await tryCoreJobDelete(c, c.req.param('jobId'), core!)
      if (!r) return c.json({ bridged: false }, 500)
      return r
    })

    const res = await app.request('/del-job-1', {
      method: 'DELETE',
      headers: { Authorization: 'Bearer u1' }
    })
    assert.equal(res.status, 200)
    const body = (await res.json()) as {
      success: boolean
      data: { deleted: boolean; job: { status: string; id: string } }
    }
    assert.equal(body.success, true)
    assert.equal(body.data.deleted, true)
    assert.equal(body.data.job.id, 'del-job-1')
    assert.equal(body.data.job.status, 'cancelled')

    const stored = await core.jobs.get('del-job-1')
    assert.equal(stored?.status, 'cancelled')
  })

  it('tryCoreJobDelete returns null when job missing in core (B3)', async () => {
    core = createApplication({ mode: 'memory' })
    const app = new Hono()
    app.delete('/:jobId', async (c) => {
      const r = await tryCoreJobDelete(c, 'missing-del', core!)
      return c.json({ bridged: r !== null })
    })
    const res = await app.request('/missing-del', {
      method: 'DELETE',
      headers: { Authorization: 'Bearer u1' }
    })
    const body = (await res.json()) as { bridged: boolean }
    assert.equal(body.bridged, false)
  })

  it('tryMapCoreJobToLegacy supports thread get / latest enrichment (B4)', async () => {
    core = createApplication({ mode: 'memory' })
    await core.jobs.save(
      createJob({
        id: 'thread-job-1',
        status: 'paused',
        stateRevision: 3
      })
    )
    const mapped = await tryMapCoreJobToLegacy('thread-job-1', core)
    assert.ok(mapped)
    assert.equal(mapped.status, 'paused')
    assert.equal(mapped.stateRevision, 3)
    assert.deepEqual([...mapped.availableActions], ['continue', 'cancel'])

    const missing = await tryMapCoreJobToLegacy('nope', core)
    assert.equal(missing, null)
  })

  it('tryCoreJobSseSnapshot maps via legacy-sse-mapper when job in core (B7)', async () => {
    core = createApplication({ mode: 'memory' })
    await core.jobs.save(
      createJob({
        id: 'sse-job-1',
        status: 'running',
        stateRevision: 4
      })
    )
    const snapshot = await tryCoreJobSseSnapshot('sse-job-1', core)
    assert.ok(snapshot)
    assert.equal(snapshot.id, 'sse-job-1')
    assert.equal(snapshot.status, 'running')
    assert.equal(snapshot.stateRevision, 4)

    const missing = await tryCoreJobSseSnapshot('sse-missing', core)
    assert.equal(missing, null)
  })
})
