/**
 * Thin draft HTTP routes — call application commands/queries only.
 */
import {
  handleRoute,
  requireIdempotencyKey,
  RouteSchemaError,
  type HttpRequest,
  type HttpResult
} from '../route-handler'
import { getDraftQuery } from '../../../core/application/queries/get-draft'
import { confirmDraftCommand } from '../../../core/application/commands/confirm-draft'
import { patchDraftCommand } from '../../../core/application/commands/patch-draft'
import { confirmDraftSectionCommand } from '../../../core/application/commands/confirm-draft-section'
import { unlockDraftCommand } from '../../../core/application/commands/unlock-draft'
import { confirmDraftFinalCommand } from '../../../core/application/commands/confirm-draft-final'
import type { DraftRepo, JobRepo, PlanRepo } from '../../../core/application/ports/repositories'
import type { IdGenerator } from '../../../core/application/ports/id-generator'
import type { UnitOfWork } from '../../../core/application/ports/unit-of-work'
import type { IdempotencyStore } from '../../../core/application/idempotency'
import { mapDraftToLegacySummary } from '../../../compatibility/legacy-api-mapper'
import { projectDraft } from '../../../core/application/queries/get-draft'

/** Loose payload shape accepted by patch routes (maps onto draft writer commands). */
type DraftPayloadBody = {
  readonly sections?: Readonly<Record<string, { locked?: boolean; content?: string }>>
  readonly planId?: string | null
  readonly jobId?: string | null
  readonly wizardPhase?: string
}

export type DraftRouteDeps = {
  readonly drafts: DraftRepo
  readonly unitOfWork: UnitOfWork
  readonly idempotency: IdempotencyStore
  readonly jobs?: JobRepo
  readonly plans?: PlanRepo
  readonly ids?: IdGenerator
}

function asRecord(body: unknown): Record<string, unknown> {
  if (body === undefined || body === null) return {}
  if (typeof body !== 'object' || Array.isArray(body)) {
    throw new RouteSchemaError('body must be an object', 'body')
  }
  return body as Record<string, unknown>
}

function parsePayload(value: unknown): DraftPayloadBody | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new RouteSchemaError('payload must be an object', 'payload')
  }
  return value as DraftPayloadBody
}

function mapDraftSuccess(draft: {
  id: string
  status: 'collecting' | 'confirmed' | 'abandoned'
  revision: number
  content: string
  projectId: string
  threadId: string
  payload?: DraftPayloadBody
}) {
  return { draft: mapDraftToLegacySummary(projectDraft(draft as never)) }
}

export function createDraftRoutes(deps: DraftRouteDeps) {
  return {
    async getDraft(request: HttpRequest): Promise<HttpResult<unknown>> {
      return handleRoute(request, {
        parse: (_auth, req) => {
          const draftId = req.params?.draftId ?? req.params?.id
          if (!draftId) throw new RouteSchemaError('draftId is required', 'draftId')
          return { draftId }
        },
        invoke: (input) => getDraftQuery({ drafts: deps.drafts }, input),
        mapSuccess: (draft) => ({ draft: mapDraftToLegacySummary(draft) })
      })
    },

    async confirmDraft(request: HttpRequest): Promise<HttpResult<unknown>> {
      return handleRoute(request, {
        parse: (_auth, req) => {
          const draftId = req.params?.draftId ?? req.params?.id
          if (!draftId) throw new RouteSchemaError('draftId is required', 'draftId')
          const body = asRecord(req.body)
          const expectedRevision = Number(body.expectedRevision ?? body.revision ?? 0)
          if (!Number.isFinite(expectedRevision)) {
            throw new RouteSchemaError('expectedRevision is required', 'expectedRevision')
          }
          const idempotencyKey = requireIdempotencyKey(req.headers)
          const payloadHash = JSON.stringify({ draftId, expectedRevision })
          return { draftId, expectedRevision, idempotencyKey, payloadHash }
        },
        invoke: (input) =>
          confirmDraftCommand(
            {
              drafts: deps.drafts,
              unitOfWork: deps.unitOfWork,
              idempotency: deps.idempotency
            },
            input
          ),
        mapSuccess: (value) => mapDraftSuccess(value.draft)
      })
    },

    async patchDraft(request: HttpRequest): Promise<HttpResult<unknown>> {
      return handleRoute(request, {
        parse: (_auth, req) => {
          const draftId = req.params?.draftId ?? req.params?.id
          if (!draftId) throw new RouteSchemaError('draftId is required', 'draftId')
          const body = asRecord(req.body)
          const expectedRevision = Number(body.expectedRevision ?? body.revision ?? 0)
          if (!Number.isFinite(expectedRevision)) {
            throw new RouteSchemaError('expectedRevision is required', 'expectedRevision')
          }
          const content =
            body.content !== undefined
              ? String(body.content)
              : body.summary !== undefined
                ? String(body.summary)
                : undefined
          const payload = parsePayload(body.payload)
          const idempotencyKey = requireIdempotencyKey(req.headers)
          const payloadHash = JSON.stringify({ draftId, expectedRevision, content, payload })
          return {
            draftId,
            expectedRevision,
            ...(content !== undefined ? { content } : {}),
            ...(payload !== undefined ? { payload } : {}),
            idempotencyKey,
            payloadHash
          }
        },
        invoke: (input) =>
          patchDraftCommand(
            {
              drafts: deps.drafts,
              unitOfWork: deps.unitOfWork,
              idempotency: deps.idempotency
            },
            input
          ),
        mapSuccess: (value) => mapDraftSuccess(value.draft)
      })
    },

    async confirmDraftSection(request: HttpRequest): Promise<HttpResult<unknown>> {
      return handleRoute(request, {
        parse: (_auth, req) => {
          const draftId = req.params?.draftId ?? req.params?.id
          if (!draftId) throw new RouteSchemaError('draftId is required', 'draftId')
          const sectionKey = (req.params?.section ?? req.params?.sectionKey ?? '').trim()
          if (!sectionKey) throw new RouteSchemaError('section is required', 'section')
          const body = asRecord(req.body)
          const expectedRevision = Number(body.expectedRevision ?? body.revision ?? 0)
          if (!Number.isFinite(expectedRevision)) {
            throw new RouteSchemaError('expectedRevision is required', 'expectedRevision')
          }
          const idempotencyKey = requireIdempotencyKey(req.headers)
          const payloadHash = JSON.stringify({ draftId, expectedRevision, sectionKey })
          return { draftId, expectedRevision, sectionKey, idempotencyKey, payloadHash }
        },
        invoke: (input) =>
          confirmDraftSectionCommand(
            {
              drafts: deps.drafts,
              unitOfWork: deps.unitOfWork,
              idempotency: deps.idempotency
            },
            input
          ),
        mapSuccess: (value) => mapDraftSuccess(value.draft)
      })
    },

    async unlockDraft(request: HttpRequest): Promise<HttpResult<unknown>> {
      return handleRoute(request, {
        parse: (_auth, req) => {
          const draftId = req.params?.draftId ?? req.params?.id
          if (!draftId) throw new RouteSchemaError('draftId is required', 'draftId')
          const body = asRecord(req.body)
          const expectedRevision = Number(body.expectedRevision ?? body.revision ?? 0)
          if (!Number.isFinite(expectedRevision)) {
            throw new RouteSchemaError('expectedRevision is required', 'expectedRevision')
          }
          const idempotencyKey = requireIdempotencyKey(req.headers)
          const payloadHash = JSON.stringify({ draftId, expectedRevision })
          return { draftId, expectedRevision, idempotencyKey, payloadHash }
        },
        invoke: (input) =>
          unlockDraftCommand(
            {
              drafts: deps.drafts,
              unitOfWork: deps.unitOfWork,
              idempotency: deps.idempotency,
              ...(deps.jobs ? { jobs: deps.jobs } : {})
            },
            input
          ),
        mapSuccess: (value) => mapDraftSuccess(value.draft)
      })
    },

    async confirmDraftFinal(request: HttpRequest): Promise<HttpResult<unknown>> {
      return handleRoute(request, {
        parse: (_auth, req) => {
          const draftId = req.params?.draftId ?? req.params?.id
          if (!draftId) throw new RouteSchemaError('draftId is required', 'draftId')
          if (!deps.plans || !deps.jobs || !deps.ids) {
            throw new RouteSchemaError(
              'confirm-final requires plans/jobs/ids deps',
              'deps'
            )
          }
          const body = asRecord(req.body)
          const expectedRevision = Number(body.expectedRevision ?? body.revision ?? 0)
          if (!Number.isFinite(expectedRevision)) {
            throw new RouteSchemaError('expectedRevision is required', 'expectedRevision')
          }
          const jobId =
            body.jobId !== undefined && String(body.jobId).trim()
              ? String(body.jobId).trim()
              : undefined
          const idempotencyKey = requireIdempotencyKey(req.headers)
          const payloadHash = JSON.stringify({ draftId, expectedRevision, jobId })
          return {
            draftId,
            expectedRevision,
            ...(jobId !== undefined ? { jobId } : {}),
            idempotencyKey,
            payloadHash
          }
        },
        invoke: (input) =>
          confirmDraftFinalCommand(
            {
              drafts: deps.drafts,
              plans: deps.plans!,
              jobs: deps.jobs!,
              ids: deps.ids!,
              unitOfWork: deps.unitOfWork,
              idempotency: deps.idempotency
            },
            input
          ),
        mapSuccess: (value) => ({
          ...mapDraftSuccess(value.draft),
          job: {
            id: value.job.id,
            status: value.job.status,
            stateRevision: value.job.stateRevision
          }
        })
      })
    }
  }
}

export type DraftRoutes = ReturnType<typeof createDraftRoutes>
