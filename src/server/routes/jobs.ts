import { Hono } from 'hono'
import type { AppContext } from '../context'
import { requireUsername } from '../auth/session'
import {
  confirmDraftMessage,
  deleteDraftReference,
  getLatestThreadJob,
  getThreadJob,
  getUserJob,
  importDraftReferences,
  addLocalCorpusDraftReference,
  listUserJobs,
  updateDraftAbilityCores,
  updateDraftReferenceDescription,
  uploadDraftReferences
} from '../legacy-control-plane/service'
import {
  confirmDraftAndStartPlanning,
  confirmDraftSection,
  confirmExecutionPlan,
  confirmPlanNode,
  listThreadDrafts,
  listThreadPlans,
  unlockDraftForEdit,
  unlockRequirementsContractForEdit,
  updateDraftContent,
  updateJobPlan
} from '../legacy-control-plane/draft-plan'
import {
  cancelJob,
  deleteJob,
  pauseJob,
  restartJob,
  resumePausedJob,
  continueJob,
  attachControlPlaneJobFields
} from '../legacy-control-plane/controls'
import { AppError } from '../error'
import { ok } from '../response'
import { createLegacyCutoverGuard } from '../http/legacy-cutover-guard'
import { bodySizeLimit } from '../middleware/body-limiter'
import {
  MAX_MULTIPART_BODY_BYTES,
  parseLimitedMultipartFiles
} from '../middleware/multipart-upload'
import type { TaskLaunchDraftLockedSections } from '../conversation/draft/types'

const DRAFT_SECTION_KEYS = [
  'requirementsContract',
  'abilities',
  'references',
  'acceptance',
  'userFlow',
  'techStack'
] as const satisfies ReadonlyArray<keyof TaskLaunchDraftLockedSections>

type DraftSectionKey = (typeof DRAFT_SECTION_KEYS)[number]

function parseDraftSection(raw: string): DraftSectionKey {
  if ((DRAFT_SECTION_KEYS as readonly string[]).includes(raw)) {
    return raw as DraftSectionKey
  }
  throw AppError.badRequest('Invalid draft section', 'draft.invalid_section', { section: raw })
}

function parseOptionalString(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') {
    throw AppError.badRequest('Invalid string field', 'draft.invalid_payload')
  }
  return value
}

function parseOptionalStringArray(value: unknown): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw AppError.badRequest('Invalid string array field', 'draft.invalid_payload')
  }
  return value
}

function parseOptionalRevision(value: unknown): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw AppError.badRequest('Invalid revision', 'draft.invalid_payload')
  }
  return value
}

function parseUpdateDraftContentPatch(body: unknown): Parameters<typeof updateDraftContent>[3] {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw AppError.badRequest('Invalid draft patch', 'draft.invalid_payload')
  }
  const record = body as Record<string, unknown>
  return {
    ...(record.title !== undefined ? { title: parseOptionalString(record.title)! } : {}),
    ...(record.summary !== undefined ? { summary: parseOptionalString(record.summary)! } : {}),
    ...(record.userFlow !== undefined ? { userFlow: parseOptionalString(record.userFlow)! } : {}),
    ...(record.techStack !== undefined
      ? { techStack: parseOptionalString(record.techStack)! }
      : {}),
    ...(record.requirementsContractMarkdown !== undefined
      ? {
          requirementsContractMarkdown: parseOptionalString(record.requirementsContractMarkdown)!
        }
      : {}),
    ...(record.nfr !== undefined ? { nfr: parseOptionalStringArray(record.nfr)! } : {}),
    ...(record.outOfScope !== undefined
      ? { outOfScope: parseOptionalStringArray(record.outOfScope)! }
      : {}),
    ...(record.assumptions !== undefined
      ? { assumptions: parseOptionalStringArray(record.assumptions)! }
      : {}),
    ...(record.revision !== undefined ? { revision: parseOptionalRevision(record.revision)! } : {})
  }
}

function parsePlanNodeRef(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) {
    throw AppError.badRequest('nodeRef is required', 'job.node_ref_required')
  }
  return trimmed
}

export function createJobRoutes(_ctx: AppContext): Hono {
  const routes = new Hono()
  const legacyWriteGuard = createLegacyCutoverGuard()

  routes.get('/:threadId/drafts', async (c) => {
    const username = await requireUsername(c.req.header('Authorization'))
    const drafts = await listThreadDrafts(username, c.req.param('threadId'))
    return c.json(ok({ drafts }))
  })

  routes.get('/:threadId/plans', async (c) => {
    const username = await requireUsername(c.req.header('Authorization'))
    const plans = await listThreadPlans(username, c.req.param('threadId'))
    return c.json(ok({ plans }))
  })

  routes.get('/:threadId/jobs/latest', async (c) => {
    const username = await requireUsername(c.req.header('Authorization'))
    const job = await getLatestThreadJob(username, c.req.param('threadId'))
    return c.json(ok({ job }))
  })

  routes.get('/:threadId/jobs/:jobId', async (c) => {
    const username = await requireUsername(c.req.header('Authorization'))
    const job = await getThreadJob(username, c.req.param('threadId'), c.req.param('jobId'))
    if (!job) throw AppError.notFound('Job not found', 'job.not_found')
    return c.json(ok({ job }))
  })

  routes.get('/:threadId/jobs/:jobId/tasks/:taskId/evidence', async (c) => {
    const username = await requireUsername(c.req.header('Authorization'))
    const { getTaskEvidenceDetailForUser } = await import('../legacy-control-plane/service')
    const detail = await getTaskEvidenceDetailForUser({
      username,
      threadId: c.req.param('threadId'),
      jobId: c.req.param('jobId'),
      taskId: c.req.param('taskId')
    })
    if (!detail) throw AppError.notFound('Evidence detail unavailable or expired')
    return c.json(ok(detail))
  })

  routes.post('/:threadId/jobs', legacyWriteGuard, async (c) => {
    const username = await requireUsername(c.req.header('Authorization'))
    const body = await c.req.json<{ draftMessageId?: string }>()
    if (!body.draftMessageId?.trim()) {
      throw AppError.badRequest('draftMessageId is required', 'job.draft_message_id_required')
    }
    const result = await confirmDraftAndStartPlanning(
      username,
      c.req.param('threadId'),
      body.draftMessageId.trim()
    )
    return c.json(ok(result))
  })

  routes.post('/:threadId/jobs/:jobId/confirm-plan', legacyWriteGuard, async (c) => {
    const username = await requireUsername(c.req.header('Authorization'))
    const job = await confirmExecutionPlan(username, c.req.param('threadId'), c.req.param('jobId'))
    return c.json(ok({ job }))
  })

  routes.patch('/:threadId/jobs/:jobId/plan', legacyWriteGuard, async (c) => {
    const username = await requireUsername(c.req.header('Authorization'))
    const body = await c.req.json<{
      nodeRef?: string
      expectedPlanRevision?: number
      title?: string
      description?: string
      successCriteria?: string
      contextMarkdown?: string
      abilityCode?: string
      coreCode?: string
      referenceIds?: string[]
      referenceReason?: string
    }>()
    if (!body.nodeRef?.trim())
      throw AppError.badRequest('nodeRef is required', 'job.node_ref_required')
    const job = await updateJobPlan(username, c.req.param('threadId'), c.req.param('jobId'), {
      nodeRef: body.nodeRef.trim(),
      expectedPlanRevision: body.expectedPlanRevision,
      title: body.title,
      description: body.description,
      successCriteria: body.successCriteria,
      contextMarkdown: body.contextMarkdown,
      abilityCode: body.abilityCode,
      coreCode: body.coreCode,
      referenceIds: Array.isArray(body.referenceIds) ? body.referenceIds : undefined,
      referenceReason: body.referenceReason
    })
    return c.json(ok({ job }))
  })

  routes.post('/:threadId/jobs/:jobId/plan/nodes/:nodeRef/confirm', legacyWriteGuard, async (c) => {
    const username = await requireUsername(c.req.header('Authorization'))
    const job = await confirmPlanNode(
      username,
      c.req.param('threadId'),
      c.req.param('jobId'),
      parsePlanNodeRef(c.req.param('nodeRef'))
    )
    return c.json(ok({ job }))
  })

  routes.post('/:threadId/messages/:messageId/draft/confirm', legacyWriteGuard, async (c) => {
    const username = await requireUsername(c.req.header('Authorization'))
    const result = await confirmDraftMessage(
      username,
      c.req.param('threadId'),
      c.req.param('messageId')
    )
    return c.json(ok(result))
  })

  routes.post('/:threadId/messages/:messageId/draft/confirm-final', legacyWriteGuard, async (c) => {
    const username = await requireUsername(c.req.header('Authorization'))
    const result = await confirmDraftAndStartPlanning(
      username,
      c.req.param('threadId'),
      c.req.param('messageId')
    )
    return c.json(ok(result))
  })

  routes.post('/:threadId/messages/:messageId/draft/unlock', legacyWriteGuard, async (c) => {
    const username = await requireUsername(c.req.header('Authorization'))
    const result = await unlockDraftForEdit(
      username,
      c.req.param('threadId'),
      c.req.param('messageId')
    )
    return c.json(ok(result))
  })

  routes.post(
    '/:threadId/messages/:messageId/draft/unlock-contract',
    legacyWriteGuard,
    async (c) => {
      const username = await requireUsername(c.req.header('Authorization'))
      const result = await unlockRequirementsContractForEdit(
        username,
        c.req.param('threadId'),
        c.req.param('messageId')
      )
      return c.json(ok(result))
    }
  )

  routes.patch('/:threadId/messages/:messageId/draft', legacyWriteGuard, async (c) => {
    const username = await requireUsername(c.req.header('Authorization'))
    const body: unknown = await c.req.json()
    const result = await updateDraftContent(
      username,
      c.req.param('threadId'),
      c.req.param('messageId'),
      parseUpdateDraftContentPatch(body)
    )
    return c.json(ok(result))
  })

  routes.post(
    '/:threadId/messages/:messageId/draft/sections/:section/confirm',
    legacyWriteGuard,
    async (c) => {
      const username = await requireUsername(c.req.header('Authorization'))
      const section = parseDraftSection(c.req.param('section'))
      const result = await confirmDraftSection(
        username,
        c.req.param('threadId'),
        c.req.param('messageId'),
        section
      )
      return c.json(ok(result))
    }
  )

  routes.patch('/:threadId/messages/:messageId/draft/abilities', legacyWriteGuard, async (c) => {
    const username = await requireUsername(c.req.header('Authorization'))
    const body = await c.req.json<{
      selections?: Array<{ abilityCode?: string; coreCode?: string }>
    }>()
    const selections = (body.selections ?? [])
      .map((item) => ({
        abilityCode: item.abilityCode?.trim() ?? '',
        coreCode: item.coreCode?.trim() ?? ''
      }))
      .filter((item) => item.abilityCode && item.coreCode)
    if (selections.length === 0) {
      throw AppError.badRequest('Ability selections are required', 'job.selections_required')
    }
    const result = await updateDraftAbilityCores(
      username,
      c.req.param('threadId'),
      c.req.param('messageId'),
      selections
    )
    return c.json(ok(result))
  })

  routes.post(
    '/:threadId/messages/:messageId/draft/references',
    legacyWriteGuard,
    bodySizeLimit(MAX_MULTIPART_BODY_BYTES),
    async (c) => {
      const username = await requireUsername(c.req.header('Authorization'))
      const threadId = c.req.param('threadId')
      const messageId = c.req.param('messageId')
      const uploadFiles = await parseLimitedMultipartFiles(c, {
        emptyErrorCode: 'draft.references_required',
        emptyErrorMessage: 'At least one reference file is required'
      })

      const result = await uploadDraftReferences(username, threadId, messageId, uploadFiles)
      return c.json(ok(result))
    }
  )

  routes.delete(
    '/:threadId/messages/:messageId/draft/references/:referenceId',
    legacyWriteGuard,
    async (c) => {
      const username = await requireUsername(c.req.header('Authorization'))
      const result = await deleteDraftReference(
        username,
        c.req.param('threadId'),
        c.req.param('messageId'),
        c.req.param('referenceId')
      )
      return c.json(ok(result))
    }
  )

  routes.post(
    '/:threadId/messages/:messageId/draft/references/import',
    legacyWriteGuard,
    async (c) => {
      const username = await requireUsername(c.req.header('Authorization'))
      const body = await c.req.json<{
        attachmentIds?: string[]
        descriptions?: Record<string, string>
      }>()
      const attachmentIds = (body.attachmentIds ?? []).map((id) => id.trim()).filter(Boolean)
      if (attachmentIds.length === 0) {
        throw AppError.badRequest('attachmentIds are required', 'draft.attachment_ids_required')
      }
      const result = await importDraftReferences(
        username,
        c.req.param('threadId'),
        c.req.param('messageId'),
        attachmentIds,
        body.descriptions ?? {}
      )
      return c.json(ok(result))
    }
  )

  routes.post(
    '/:threadId/messages/:messageId/draft/references/local-corpus',
    legacyWriteGuard,
    async (c) => {
      const username = await requireUsername(c.req.header('Authorization'))
      const body = await c.req.json<{
        localPath?: string
        name?: string
        description?: string
        kind?: 'file' | 'directory'
      }>()
      if (!body.localPath?.trim())
        throw AppError.badRequest('localPath is required', 'draft.local_path_required')
      if (!body.description?.trim())
        throw AppError.badRequest('Description is required', 'draft.reference_description_missing')
      const result = await addLocalCorpusDraftReference(
        username,
        c.req.param('threadId'),
        c.req.param('messageId'),
        {
          localPath: body.localPath.trim(),
          name: body.name?.trim() ?? '',
          description: body.description.trim(),
          kind: body.kind
        }
      )
      return c.json(ok(result))
    }
  )

  routes.patch(
    '/:threadId/messages/:messageId/draft/references/:referenceId',
    legacyWriteGuard,
    async (c) => {
      const username = await requireUsername(c.req.header('Authorization'))
      const body = await c.req.json<{ description?: string }>()
      const result = await updateDraftReferenceDescription(
        username,
        c.req.param('threadId'),
        c.req.param('messageId'),
        c.req.param('referenceId'),
        body.description ?? ''
      )
      return c.json(ok(result))
    }
  )

  return routes
}

export function createUserJobRoutes(_ctx: AppContext): Hono {
  const routes = new Hono()
  const legacyWriteGuard = createLegacyCutoverGuard()

  routes.post('/queue/resume', legacyWriteGuard, async (c) => {
    const username = await requireUsername(c.req.header('Authorization'))
    const { resumeJobQueueForUser } = await import('../legacy-control-plane/job-queue')
    await resumeJobQueueForUser(username)
    return c.json(ok({ resumed: true }))
  })

  routes.get('/', async (c) => {
    const username = await requireUsername(c.req.header('Authorization'))
    const status = c.req.query('status') ?? 'all'
    const page = Number(c.req.query('page') ?? '1')
    const limit = Math.min(100, Math.max(1, Number(c.req.query('limit')) || 50))
    const q = c.req.query('q')?.trim()
    const result = await listUserJobs(username, { status, page, limit, q: q || undefined })
    return c.json(ok(result))
  })

  routes.get('/:jobId', async (c) => {
    const username = await requireUsername(c.req.header('Authorization'))
    const job = await getUserJob(username, c.req.param('jobId'))
    if (!job) throw AppError.notFound('Job not found', 'job.not_found')
    return c.json(ok({ job }))
  })

  routes.post('/:jobId/pause', legacyWriteGuard, async (c) => {
    const username = await requireUsername(c.req.header('Authorization'))
    const job = attachControlPlaneJobFields(
      username,
      await pauseJob(username, c.req.param('jobId'))
    )
    return c.json(ok({ job }))
  })

  routes.post('/:jobId/resume', legacyWriteGuard, async (c) => {
    const username = await requireUsername(c.req.header('Authorization'))
    const job = attachControlPlaneJobFields(
      username,
      await resumePausedJob(username, c.req.param('jobId'))
    )
    return c.json(ok({ job }))
  })

  routes.post('/:jobId/continue', legacyWriteGuard, async (c) => {
    const username = await requireUsername(c.req.header('Authorization'))
    const job = attachControlPlaneJobFields(
      username,
      await continueJob(username, c.req.param('jobId'))
    )
    return c.json(ok({ job }))
  })

  routes.post('/:jobId/cancel', legacyWriteGuard, async (c) => {
    const username = await requireUsername(c.req.header('Authorization'))
    const job = attachControlPlaneJobFields(
      username,
      await cancelJob(username, c.req.param('jobId'))
    )
    return c.json(ok({ job }))
  })

  routes.post('/:jobId/restart', legacyWriteGuard, async (c) => {
    const username = await requireUsername(c.req.header('Authorization'))
    const job = attachControlPlaneJobFields(
      username,
      await restartJob(username, c.req.param('jobId'))
    )
    return c.json(ok({ job }))
  })

  routes.post('/:jobId/retry-planning', legacyWriteGuard, async (c) => {
    const username = await requireUsername(c.req.header('Authorization'))
    const { retryJobPlanning } = await import('../legacy-control-plane/service')
    const job = await retryJobPlanning(username, c.req.param('jobId'))
    return c.json(ok({ job }))
  })

  routes.delete('/:jobId', legacyWriteGuard, async (c) => {
    const username = await requireUsername(c.req.header('Authorization'))
    await deleteJob(username, c.req.param('jobId'))
    return c.json(ok({ deleted: true }))
  })

  return routes
}
