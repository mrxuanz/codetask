import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  apiStatus,
  assertAuthBoundary,
  handleRoute,
  mapApplicationError,
  mapErrorCodeToHttp,
  readIdempotencyKey,
  requireIdempotencyKey,
  RouteAuthError,
  RouteSchemaError,
  type HttpRequest
} from '../../../src/server/interfaces/http/route-handler.ts'
import { createJobRoutes } from '../../../src/server/interfaces/http/routes/jobs.ts'
import { createHttpServer } from '../../../src/server/composition/create-http-server.ts'
import { fail, ok } from '../../../src/server/core/application/results.ts'
import { createJob } from '../../../src/server/core/domain/jobs/types.ts'
import type { JobRepo } from '../../../src/server/core/application/ports/repositories.ts'
import type { UnitOfWork } from '../../../src/server/core/application/ports/unit-of-work.ts'
import type { IdempotencyStore } from '../../../src/server/core/application/idempotency.ts'
import type { ThreadRepo } from '../../../src/server/core/application/ports/repositories.ts'
import type { DraftRepo } from '../../../src/server/core/application/ports/repositories.ts'
import type { PlanRepo } from '../../../src/server/core/application/ports/repositories.ts'
import type { IdGenerator } from '../../../src/server/core/application/ports/id-generator.ts'

function headers(
  input: Record<string, string | undefined>
): HttpRequest['headers'] {
  const out: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(input)) {
    out[k] = v
    out[k.toLowerCase()] = v
  }
  return out
}

describe('route-wrapper', () => {
  it('documents four duties via handleRoute composition', async () => {
    const duties: string[] = []
    const result = await handleRoute(
      {
        method: 'GET',
        path: '/api/threads/t1/agent',
        headers: headers({ Authorization: 'Bearer demo-token' })
      },
      {
        parse: (auth) => {
          duties.push('auth+schema')
          assert.equal(auth.username.length > 0, true)
          return { threadId: 't1' }
        },
        invoke: async () => {
          duties.push('command')
          return ok({ configured: true })
        },
        mapSuccess: (value) => {
          duties.push('map')
          return value
        }
      }
    )
    assert.equal(result.ok, true)
    assert.deepEqual(duties, ['auth+schema', 'command', 'map'])
  })

  it('rejects missing Authorization at auth boundary', () => {
    assert.throws(() => assertAuthBoundary(headers({})), RouteAuthError)
    const mapped = mapApplicationError({ code: 'auth.unauthorized', message: 'Not signed in' })
    assert.equal(mapped.httpStatus, 401)
    assert.equal(mapped.body.status, apiStatus.UNAUTHORIZED)
    assert.equal(mapped.body.data.turnErrorCode, 'auth.unauthorized')
  })

  it('honors Idempotency-Key header at route boundary', () => {
    const h = headers({ 'Idempotency-Key': 'idem-pause-001' })
    assert.equal(readIdempotencyKey(h), 'idem-pause-001')
    assert.equal(requireIdempotencyKey(h), 'idem-pause-001')
    assert.throws(
      () => requireIdempotencyKey(headers({})),
      (err: unknown) => err instanceof RouteSchemaError && err.field === 'Idempotency-Key'
    )
  })

  it('maps application error codes to user-visible HTTP semantics', () => {
    assert.deepEqual(mapErrorCodeToHttp('job.not_found'), {
      httpStatus: 404,
      status: apiStatus.NOT_FOUND
    })
    assert.deepEqual(mapErrorCodeToHttp('job.revision_conflict'), {
      httpStatus: 409,
      status: apiStatus.CONFLICT
    })
    assert.deepEqual(mapErrorCodeToHttp('idempotency.conflict'), {
      httpStatus: 409,
      status: apiStatus.CONFLICT
    })
    assert.deepEqual(mapErrorCodeToHttp('idempotency_key_reused'), {
      httpStatus: 409,
      status: apiStatus.CONFLICT
    })
    assert.deepEqual(mapErrorCodeToHttp('contract.invalid_payload'), {
      httpStatus: 400,
      status: apiStatus.BAD_REQUEST
    })
    const conflict = mapApplicationError({
      code: 'job.revision_conflict',
      message: 'job.revision_conflict'
    })
    assert.equal(conflict.httpStatus, 409)
    assert.equal(conflict.body.status, apiStatus.CONFLICT)
    assert.equal(conflict.body.data.turnErrorCode, 'job.revision_conflict')
  })

  it('job pause route requires Idempotency-Key and maps not_found', async () => {
    const jobs: JobRepo = {
      async get() {
        return undefined
      },
      async save() {
        return
      }
    }
    const unitOfWork: UnitOfWork = {
      enqueueEvent() {
        return
      },
      async run(fn) {
        return fn(unitOfWork)
      }
    }
    const idempotency: IdempotencyStore = {
      async get() {
        return undefined
      },
      async put() {
        return
      }
    }
    const routes = createJobRoutes({ jobs, unitOfWork, idempotency })

    const missingKey = await routes.pause({
      method: 'POST',
      path: '/api/jobs/job-1/pause',
      headers: headers({
        Authorization: 'Bearer demo',
        'If-Match': '"1"'
      }),
      params: { jobId: 'job-1' },
      body: {}
    })
    assert.equal(missingKey.ok, false)
    if (!missingKey.ok) {
      assert.equal(missingKey.httpStatus, 400)
      assert.equal(missingKey.body.data.turnErrorCode, 'contract.invalid_payload')
    }

    const notFound = await routes.pause({
      method: 'POST',
      path: '/api/jobs/job-1/pause',
      headers: headers({
        Authorization: 'Bearer demo',
        'If-Match': '"1"',
        'Idempotency-Key': 'idem-1'
      }),
      params: { jobId: 'job-1' },
      body: {}
    })
    assert.equal(notFound.ok, false)
    if (!notFound.ok) {
      assert.equal(notFound.httpStatus, 404)
      assert.equal(notFound.body.status, apiStatus.NOT_FOUND)
      assert.equal(notFound.body.data.turnErrorCode, 'job.not_found')
    }
  })

  it('createHttpServer wires interface routes on new composition root', async () => {
    const job = createJob({ id: 'job-1', status: 'running', stateRevision: 2 })
    const jobs: JobRepo = {
      async get(id) {
        return id === job.id ? job : undefined
      },
      async save() {
        return
      }
    }
    const emptyRepo = {
      async get() {
        return undefined
      },
      async save() {
        return
      }
    }
    const unitOfWork: UnitOfWork = {
      enqueueEvent() {
        return
      },
      async run(fn) {
        return fn(unitOfWork)
      }
    }
    const idempotency: IdempotencyStore = {
      async get() {
        return undefined
      },
      async put() {
        return
      }
    }
    const ids: IdGenerator = { next: () => 'id-1' }
    const server = createHttpServer({
      threads: emptyRepo as ThreadRepo,
      drafts: emptyRepo as DraftRepo,
      plans: emptyRepo as PlanRepo,
      jobs,
      unitOfWork,
      idempotency,
      ids
    })
    assert.equal(server.kind, 'new-core')
    assert.equal(typeof server.routes.jobs.getJob, 'function')
    assert.equal(typeof server.routes.conversation.getThreadAgent, 'function')
    assert.equal(typeof server.routes.drafts.confirmDraft, 'function')
    assert.equal(typeof server.routes.plans.confirmPlan, 'function')

    const result = await server.routes.jobs.getJob({
      method: 'GET',
      path: '/api/jobs/job-1',
      headers: headers({ Authorization: 'Bearer demo' }),
      params: { jobId: 'job-1' }
    })
    assert.equal(result.ok, true)
    if (result.ok) {
      const data = result.body.data as { job: { id: string; status: string } }
      assert.equal(data.job.id, 'job-1')
      assert.equal(data.job.status, 'running')
    }
  })

  it('handleRoute maps invoke failures without throwing', async () => {
    const result = await handleRoute(
      {
        method: 'GET',
        path: '/x',
        headers: headers({ Authorization: 'Bearer x' })
      },
      {
        parse: () => ({}),
        invoke: async () => fail('draft.not_found', 'missing')
      }
    )
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.equal(result.httpStatus, 404)
      assert.equal(result.body.data.turnErrorCode, 'draft.not_found')
    }
  })
})
