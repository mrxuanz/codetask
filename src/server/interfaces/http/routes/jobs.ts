/**
 * Thin job-control HTTP routes — call application commands/queries only.
 */
import {
  handleRoute,
  requireIdempotencyKey,
  RouteSchemaError,
  type HttpRequest,
  type HttpResult
} from '../route-handler'
import { getJobQuery, projectJob } from '../../../core/application/queries/get-job'
import { pauseJobCommand } from '../../../core/application/commands/pause-job'
import { continueJobCommand } from '../../../core/application/commands/continue-job'
import { cancelJobCommand } from '../../../core/application/commands/cancel-job'
import { retryJobCommand } from '../../../core/application/commands/retry-job'
import type { JobRepo } from '../../../core/application/ports/repositories'
import type { UnitOfWork } from '../../../core/application/ports/unit-of-work'
import type { IdempotencyStore } from '../../../core/application/idempotency'
import { mapJobToLegacy } from '../../../compatibility/legacy-api-mapper'

export type JobRouteDeps = {
  readonly jobs: JobRepo
  readonly unitOfWork: UnitOfWork
  readonly idempotency: IdempotencyStore
}

function asRecord(body: unknown): Record<string, unknown> {
  if (body === undefined || body === null) return {}
  if (typeof body !== 'object' || Array.isArray(body)) {
    throw new RouteSchemaError('body must be an object', 'body')
  }
  return body as Record<string, unknown>
}

function parseJobCommandInput(req: HttpRequest): {
  readonly jobId: string
  readonly expectedRevision: number
  readonly idempotencyKey: string
  readonly payloadHash: string
} {
  const jobId = req.params?.jobId ?? req.params?.id
  if (!jobId) throw new RouteSchemaError('jobId is required', 'jobId')
  const body = asRecord(req.body)
  const ifMatch = req.headers['if-match'] ?? req.headers['If-Match']
  const fromHeader =
    typeof ifMatch === 'string' ? Number(ifMatch.replace(/"/g, '')) : Number.NaN
  const expectedRevision = Number(
    body.expectedRevision ?? (Number.isFinite(fromHeader) ? fromHeader : Number.NaN)
  )
  if (!Number.isFinite(expectedRevision)) {
    throw new RouteSchemaError('expectedRevision / If-Match is required', 'expectedRevision')
  }
  const idempotencyKey = requireIdempotencyKey(req.headers)
  const payloadHash = JSON.stringify({ jobId, expectedRevision, path: req.path })
  return { jobId, expectedRevision, idempotencyKey, payloadHash }
}

export function createJobRoutes(deps: JobRouteDeps) {
  const commandDeps = {
    jobs: deps.jobs,
    unitOfWork: deps.unitOfWork,
    idempotency: deps.idempotency
  }

  return {
    async getJob(request: HttpRequest): Promise<HttpResult<unknown>> {
      return handleRoute(request, {
        parse: (_auth, req) => {
          const jobId = req.params?.jobId ?? req.params?.id
          if (!jobId) throw new RouteSchemaError('jobId is required', 'jobId')
          return { jobId }
        },
        invoke: (input) => getJobQuery({ jobs: deps.jobs }, input),
        mapSuccess: (job) => ({ job: mapJobToLegacy(job) })
      })
    },

    async pause(request: HttpRequest): Promise<HttpResult<unknown>> {
      return handleRoute(request, {
        parse: (_auth, req) => parseJobCommandInput(req),
        invoke: (input) => pauseJobCommand(commandDeps, input),
        mapSuccess: (value) => ({ job: mapJobToLegacy(projectJob(value.job)) })
      })
    },

    async continue(request: HttpRequest): Promise<HttpResult<unknown>> {
      return handleRoute(request, {
        parse: (_auth, req) => parseJobCommandInput(req),
        invoke: (input) => continueJobCommand(commandDeps, input),
        mapSuccess: (value) => ({ job: mapJobToLegacy(projectJob(value.job)) })
      })
    },

    async cancel(request: HttpRequest): Promise<HttpResult<unknown>> {
      return handleRoute(request, {
        parse: (_auth, req) => parseJobCommandInput(req),
        invoke: (input) => cancelJobCommand(commandDeps, input),
        mapSuccess: (value) => ({ job: mapJobToLegacy(projectJob(value.job)) })
      })
    },

    async retry(request: HttpRequest): Promise<HttpResult<unknown>> {
      return handleRoute(request, {
        parse: (_auth, req) => parseJobCommandInput(req),
        invoke: (input) => retryJobCommand(commandDeps, input),
        mapSuccess: (value) => ({ job: mapJobToLegacy(projectJob(value.job)) })
      })
    }
  }
}

export type JobRoutes = ReturnType<typeof createJobRoutes>
