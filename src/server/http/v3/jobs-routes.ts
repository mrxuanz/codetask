import type {
  JobCommandService,
  ActorContext,
  UserCommandEnvelope,
  PayloadCommandEnvelope,
  CancelJobPayload,
  JobCommandResponse,
  CancelJobResponse
} from '@shared/contracts/control-plane'
import type { JobQueryService } from '../../application/job-query-service'
import {
  parseCancelJobPayload,
  parseIdempotencyKey,
  parseIfMatch,
  parseJobId,
  parseListJobsQuery,
  parseStateRevision
} from './request-parsers'
import { formatETag } from './headers'

export interface HttpRequest {
  readonly headers: Record<string, string | undefined>
  readonly params: Record<string, string>
  readonly query?: Record<string, string>
  readonly body?: unknown
}

export interface HttpResponse {
  readonly status: number
  readonly body: unknown
  readonly headers?: Record<string, string>
}

export interface JobsRoutes {
  pause(request: HttpRequest, actor: ActorContext): Promise<HttpResponse>
  continue(request: HttpRequest, actor: ActorContext): Promise<HttpResponse>
  cancel(request: HttpRequest, actor: ActorContext): Promise<HttpResponse>
  restartExecution(request: HttpRequest, actor: ActorContext): Promise<HttpResponse>
  getJob(request: HttpRequest, actor: ActorContext): Promise<HttpResponse>
  listJobs(request: HttpRequest, actor: ActorContext): Promise<HttpResponse>
}

export function createJobsRoutes(
  commandService: JobCommandService,
  queryService: JobQueryService
): JobsRoutes {
  return {
    async pause(request: HttpRequest, actor: ActorContext): Promise<HttpResponse> {
      const expectedRevision = parseIfMatch(request.headers['if-match'])
      const idempotencyKey = parseIdempotencyKey(request.headers['idempotency-key'])
      const jobId = parseJobId(request.params.id)

      const envelope: UserCommandEnvelope = {
        actor,
        jobId,
        expectedRevision,
        idempotencyKey
      }

      const result = await commandService.requestPause(envelope)

      return {
        status: 200,
        body: result,
        headers: { ETag: formatETag(result.job.stateRevision) }
      }
    },

    async continue(request: HttpRequest, actor: ActorContext): Promise<HttpResponse> {
      const expectedRevision = parseIfMatch(request.headers['if-match'])
      const idempotencyKey = parseIdempotencyKey(request.headers['idempotency-key'])
      const jobId = parseJobId(request.params.id)

      const envelope: UserCommandEnvelope = {
        actor,
        jobId,
        expectedRevision,
        idempotencyKey
      }

      const result = await commandService.continueJob(envelope)

      return {
        status: 200,
        body: result,
        headers: { ETag: formatETag(result.job.stateRevision) }
      }
    },

    async cancel(request: HttpRequest, actor: ActorContext): Promise<HttpResponse> {
      const expectedRevision = parseIfMatch(request.headers['if-match'])
      const idempotencyKey = parseIdempotencyKey(request.headers['idempotency-key'])
      const jobId = parseJobId(request.params.id)

      const envelope: PayloadCommandEnvelope<CancelJobPayload> = {
        actor,
        jobId,
        expectedRevision,
        idempotencyKey,
        payload: parseCancelJobPayload(request.body)
      }

      const result = await commandService.cancelJob(envelope)

      return {
        status: 200,
        body: result,
        headers: { ETag: formatETag(result.job.stateRevision) }
      }
    },

    async restartExecution(request: HttpRequest, actor: ActorContext): Promise<HttpResponse> {
      const expectedRevision = parseIfMatch(request.headers['if-match'])
      const idempotencyKey = parseIdempotencyKey(request.headers['idempotency-key'])
      const jobId = parseJobId(request.params.id)

      const envelope: PayloadCommandEnvelope<Record<string, never>> = {
        actor,
        jobId,
        expectedRevision,
        idempotencyKey,
        payload: {}
      }

      const result = await commandService.restartExecution(envelope)

      return {
        status: 200,
        body: result,
        headers: { ETag: formatETag(result.job.stateRevision) }
      }
    },

    async getJob(request: HttpRequest, actor: ActorContext): Promise<HttpResponse> {
      const jobId = parseJobId(request.params.id)
      const job = await queryService.getTaskJob(jobId, actor)
      if (!job) {
        return { status: 404, body: { error: 'Job not found' } }
      }
      return {
        status: 200,
        body: { job },
        headers: { ETag: formatETag(parseStateRevision(job.stateRevision)) }
      }
    },

    async listJobs(request: HttpRequest, actor: ActorContext): Promise<HttpResponse> {
      const query = parseListJobsQuery(request.query)
      const result = await queryService.listTaskJobs(actor, query)
      return { status: 200, body: result }
    }
  }
}

export type { JobCommandResponse, CancelJobResponse }
