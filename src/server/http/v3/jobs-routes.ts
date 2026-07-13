import type {
  JobCommandService,
  ActorContext,
  UserCommandEnvelope,
  PayloadCommandEnvelope,
  CancelJobPayload
} from '@shared/contracts/control-plane'
import type { JobQueryService } from '../../application/job-query-service'
import { commandError } from '../../domain/jobs/job-errors'

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

export function parseIfMatch(header: string | undefined): number {
  if (!header) throw new Error('If-Match header required')
  const match = header.match(/^"(\d+)"$/)
  if (!match) throw new Error('Invalid If-Match format, expected "revision"')
  return parseInt(match[1], 10)
}

export function parseIdempotencyKey(header: string | undefined): string {
  if (!header) throw new Error('Idempotency-Key header required')
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  if (!uuidRegex.test(header)) throw new Error('Invalid Idempotency-Key format, expected UUID')
  return header
}

function parseCancelPayload(body: unknown): CancelJobPayload {
  if (body === undefined) return { reasonCode: 'user_cancelled' }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw commandError('contract.invalid_payload', { field: 'body' })
  }

  const payload = body as Record<string, unknown>
  if (
    Object.keys(payload).some((key) => key !== 'reasonCode') ||
    (payload.reasonCode !== undefined &&
      (typeof payload.reasonCode !== 'string' || payload.reasonCode.length === 0))
  ) {
    throw commandError('contract.invalid_payload', { field: 'reasonCode' })
  }

  return { reasonCode: payload.reasonCode ?? 'user_cancelled' }
}

export function createJobsRoutes(
  commandService: JobCommandService,
  queryService: JobQueryService
) {
  return {
    async pause(request: HttpRequest, actor: ActorContext): Promise<HttpResponse> {
      const expectedRevision = parseIfMatch(request.headers['if-match'])
      const idempotencyKey = parseIdempotencyKey(request.headers['idempotency-key'])

      const envelope: UserCommandEnvelope = {
        actor,
        jobId: request.params.id,
        expectedRevision,
        idempotencyKey
      }

      const result = await commandService.requestPause(envelope)

      return {
        status: 200,
        body: result,
        headers: { 'ETag': `"${result.job.stateRevision}"` }
      }
    },

    async continue(request: HttpRequest, actor: ActorContext): Promise<HttpResponse> {
      const expectedRevision = parseIfMatch(request.headers['if-match'])
      const idempotencyKey = parseIdempotencyKey(request.headers['idempotency-key'])

      const envelope: UserCommandEnvelope = {
        actor,
        jobId: request.params.id,
        expectedRevision,
        idempotencyKey
      }

      const result = await commandService.continueJob(envelope)

      return {
        status: 200,
        body: result,
        headers: { 'ETag': `"${result.job.stateRevision}"` }
      }
    },

    async cancel(request: HttpRequest, actor: ActorContext): Promise<HttpResponse> {
      const expectedRevision = parseIfMatch(request.headers['if-match'])
      const idempotencyKey = parseIdempotencyKey(request.headers['idempotency-key'])

      const envelope: PayloadCommandEnvelope<CancelJobPayload> = {
        actor,
        jobId: request.params.id,
        expectedRevision,
        idempotencyKey,
        payload: parseCancelPayload(request.body)
      }

      const result = await commandService.cancelJob(envelope)

      return {
        status: 200,
        body: result,
        headers: { 'ETag': `"${result.job.stateRevision}"` }
      }
    },

    async restartExecution(request: HttpRequest, actor: ActorContext): Promise<HttpResponse> {
      const expectedRevision = parseIfMatch(request.headers['if-match'])
      const idempotencyKey = parseIdempotencyKey(request.headers['idempotency-key'])

      const envelope: PayloadCommandEnvelope<Record<string, never>> = {
        actor,
        jobId: request.params.id,
        expectedRevision,
        idempotencyKey,
        payload: {}
      }

      const result = await commandService.restartExecution(envelope)

      return {
        status: 200,
        body: result,
        headers: { 'ETag': `"${result.job.stateRevision}"` }
      }
    },

    async getJob(request: HttpRequest, actor: ActorContext): Promise<HttpResponse> {
      const job = await queryService.getTaskJob(request.params.id, actor)
      if (!job) {
        return { status: 404, body: { error: 'Job not found' } }
      }
      return {
        status: 200,
        body: { job },
        headers:
          typeof job.stateRevision === 'number'
            ? { 'ETag': `"${job.stateRevision}"` }
            : undefined
      }
    },

    async listJobs(request: HttpRequest, actor: ActorContext): Promise<HttpResponse> {
      const result = await queryService.listTaskJobs(actor, {
        projectId: request.query?.projectId,
        status: request.query?.status,
        page: request.query?.page ? Number.parseInt(request.query.page, 10) : undefined,
        limit: request.query?.limit ? Number.parseInt(request.query.limit, 10) : undefined,
        q: request.query?.q
      })
      return { status: 200, body: result }
    }
  }
}
