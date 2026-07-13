import { randomUUID } from 'crypto'
import { and, asc, eq } from 'drizzle-orm'
import type { DraftReference } from '@shared/reference-corpus'
import {
  buildJobReferenceManifest,
  collectFlatPlanReferenceIds,
  validateTaskReferenceIds,
  type JobReferenceManifest
} from '@shared/job-references'
import {
  collectMissingReferenceDescriptions,
  formatReferenceDescriptionError,
  referenceDescriptionMissing,
  referenceRequiresDescription
} from '@shared/draft-references'
import { clearPlanConfirmedFlags } from '@shared/plan-mutations'
import { getAppContext } from '../bootstrap'
import type { TaskLaunchDraftPayload, TaskLaunchDraftReference } from '../conversation/draft/types'
import {
  readThreadAttachment,
  resolveAttachmentRelativePath,
  saveThreadAttachment
} from '../conversation/attachments'
import { getDb } from '../db'
import { loadDesignPlan, saveDesignPlan } from '../db/design-plan'
import {
  threadJobs,
  draftReferences,
  type DraftReferenceRow,
  type ThreadJob
} from '../db/schema'
import { updateDesignSessionRow } from '../design-session/service'
import { AppError } from '../error'
import { serializeJobReferenceManifest } from '../legacy-control-plane/reference-manifest'
import { emitJobEvent } from '../legacy-control-plane/service'
import {
  assertLocalCorpusFileAllowed,
  inferReferenceKind,
  pathInWorkspace,
  resolveAttachmentAbsolutePath,
  resolveLocalCorpusPath
} from './paths'
import { findPlanReferenceIdsMissingFromCorpus } from './corpus-sync'

function nowSec(): number {
  return Math.floor(Date.now() / 1000)
}

function rowToDraftReference(row: DraftReferenceRow): DraftReference {
  return {
    id: row.id,
    source: row.source as DraftReference['source'],
    name: row.name,
    kind: row.kind as DraftReference['kind'],
    description: row.description,
    attachmentId: row.attachmentId ?? undefined,
    assetUrl: row.assetUrl ?? undefined,
    localPath: row.localPath ?? undefined,
    mimeType: row.mimeType ?? undefined
  }
}

function draftPayloadRefToCorpus(ref: TaskLaunchDraftReference): DraftReference {
  const extended = ref as TaskLaunchDraftReference & {
    source?: string
    localPath?: string
    kind?: DraftReference['kind']
  }
  return {
    id: ref.id,
    source: extended.source === 'local_corpus' ? 'local_corpus' : 'attachment',
    name: ref.name,
    kind: extended.kind ?? (ref.kind === 'image' ? 'image' : 'file'),
    description: ref.description?.trim() ?? '',
    attachmentId: extended.source === 'local_corpus' ? undefined : ref.id,
    assetUrl: ref.assetUrl,
    localPath: extended.localPath,
    mimeType: ref.mimeType
  }
}

export function assertCorpusDescriptionsReady(corpus: DraftReference[]): void {
  const missing = collectMissingReferenceDescriptions(corpus)
  if (missing.length > 0) {
    throw AppError.badRequest(
      formatReferenceDescriptionError(missing),
      'draft.reference_description_missing'
    )
  }
}

export async function listReferenceCorpus(designSessionId: string): Promise<DraftReference[]> {
  const db = getDb()
  const rows = await db
    .select()
    .from(draftReferences)
    .where(eq(draftReferences.designSessionId, designSessionId))
    .orderBy(asc(draftReferences.sortOrder), asc(draftReferences.createdAt))
  return rows.map(rowToDraftReference)
}

export async function syncCorpusFromDraftPayload(input: {
  designSessionId: string
  payload: TaskLaunchDraftPayload
}): Promise<void> {
  const db = getDb()
  const now = nowSec()
  const refs = [...(input.payload.references ?? [])]
  const seen = new Set(refs.map((item) => item.id))
  for (const attachment of input.payload.sourceAttachments ?? []) {
    if (seen.has(attachment.id)) continue
    seen.add(attachment.id)
    refs.push({
      id: attachment.id,
      name: attachment.name,
      mimeType: attachment.mimeType,
      kind: attachment.kind,
      assetUrl: attachment.assetUrl,
      description: '',
      source: 'message'
    })
  }

  await db.delete(draftReferences).where(eq(draftReferences.designSessionId, input.designSessionId))

  let sortOrder = 0
  for (const ref of refs) {
    const corpus = draftPayloadRefToCorpus(ref)
    await db.insert(draftReferences).values({
      id: corpus.id,
      designSessionId: input.designSessionId,
      source: corpus.source,
      name: corpus.name,
      kind: corpus.kind,
      description: corpus.description,
      attachmentId: corpus.attachmentId ?? null,
      localPath: corpus.localPath ?? null,
      resolvedPath: null,
      assetUrl: corpus.assetUrl ?? null,
      mimeType: corpus.mimeType ?? null,
      sortOrder: sortOrder++,
      createdAt: now,
      updatedAt: now
    })
  }
}

async function getDesignSessionForUser(
  username: string,
  threadId: string,
  designSessionId: string
): Promise<ThreadJob | null> {
  const db = getDb()
  const rows = await db
    .select()
    .from(threadJobs)
    .where(
      and(
        eq(threadJobs.id, designSessionId),
        eq(threadJobs.threadId, threadId),
        eq(threadJobs.username, username)
      )
    )
    .limit(1)
  return rows[0] ?? null
}

function resolveCorpusEntryPaths(input: {
  threadId: string
  workspaceRoot: string
  entry: DraftReference
  dataDir: string
}): { resolvedPath: string; inWorkspace: boolean; relativePath?: string } {
  if (input.entry.source === 'local_corpus') {
    if (!input.entry.localPath?.trim()) {
      throw AppError.badRequest(
        'Local corpus reference missing localPath',
        'draft.local_corpus.path_required'
      )
    }
    const resolvedPath = resolveLocalCorpusPath(input.entry.localPath)
    const kind = input.entry.kind === 'directory' ? 'directory' : inferReferenceKind(resolvedPath)
    if (kind === 'file') {
      assertLocalCorpusFileAllowed('file')
    }
    return {
      resolvedPath,
      inWorkspace: pathInWorkspace(resolvedPath, input.workspaceRoot)
    }
  }

  const attachmentId = input.entry.attachmentId ?? input.entry.id
  const relativePath = resolveAttachmentRelativePath(input.threadId, attachmentId)
  if (!relativePath) {
    throw AppError.badRequest(`Attachment not found: ${input.entry.name}`, 'attachment.not_found', {
      name: input.entry.name
    })
  }
  const resolvedPath = resolveAttachmentAbsolutePath(input.dataDir, input.threadId, relativePath)
  return {
    resolvedPath,
    inWorkspace: pathInWorkspace(resolvedPath, input.workspaceRoot),
    relativePath
  }
}

export function buildManifestFromCorpus(input: {
  designSessionId: string
  draftMessageId: string
  threadId: string
  workspaceRoot: string
  corpus: DraftReference[]
  manifestRevision: number
  ignoredReferenceIds?: string[]
}): JobReferenceManifest {
  const dataDir = getAppContext().dataDir
  const references = input.corpus.map((entry) => {
    const paths = resolveCorpusEntryPaths({
      threadId: input.threadId,
      workspaceRoot: input.workspaceRoot,
      entry,
      dataDir
    })
    const requiresDescription = referenceRequiresDescription({
      id: entry.id,
      name: entry.name,
      mimeType: entry.mimeType,
      kind: entry.kind === 'image' ? 'image' : 'file',
      description: entry.description
    })
    return {
      id: entry.id,
      name: entry.name,
      kind: entry.kind,
      mimeType: entry.mimeType ?? 'application/octet-stream',
      description: entry.description.trim(),
      relativePath: paths.relativePath,
      resolvedPath: paths.resolvedPath,
      source: entry.source,
      inWorkspace: paths.inWorkspace,
      requiresDescription,
      assetUrl: entry.assetUrl ?? '',
      readonly: true as const
    }
  })

  return {
    ...buildJobReferenceManifest({
      jobId: input.designSessionId,
      threadId: input.threadId,
      references,
      ignoredReferenceIds: input.ignoredReferenceIds
    }),
    designSessionId: input.designSessionId,
    draftMessageId: input.draftMessageId,
    manifestRevision: input.manifestRevision
  }
}

export async function addAttachmentToCorpus(input: {
  username: string
  threadId: string
  designSessionId: string
  name: string
  mimeType: string
  buffer: Buffer
  description?: string
}): Promise<DraftReference> {
  const session = await getDesignSessionForUser(
    input.username,
    input.threadId,
    input.designSessionId
  )
  if (!session) throw AppError.notFound('Design session not found', 'design_session.not_found')
  if (session.status === 'launched') {
    throw AppError.badRequest(
      'Design session already launched; corpus is immutable',
      'design_session.launched'
    )
  }

  const description = input.description?.trim() ?? ''
  if (!description) {
    throw AppError.badRequest('Description is required', 'draft.reference_description_missing')
  }

  const attachment = saveThreadAttachment({
    threadId: input.threadId,
    name: input.name,
    mimeType: input.mimeType,
    buffer: input.buffer
  })

  const ref: DraftReference = {
    id: attachment.id,
    source: 'attachment',
    name: attachment.name,
    kind: attachment.kind,
    description,
    attachmentId: attachment.id,
    assetUrl: attachment.assetUrl,
    mimeType: attachment.mimeType
  }
  if (referenceDescriptionMissing(ref)) {
    throw AppError.badRequest(
      formatReferenceDescriptionError([ref.name]),
      'draft.reference_description_missing'
    )
  }

  const now = nowSec()
  const db = getDb()
  const countRows = await db
    .select()
    .from(draftReferences)
    .where(eq(draftReferences.designSessionId, input.designSessionId))

  await db.insert(draftReferences).values({
    id: ref.id,
    designSessionId: input.designSessionId,
    source: ref.source,
    name: ref.name,
    kind: ref.kind,
    description: ref.description,
    attachmentId: ref.attachmentId ?? null,
    localPath: null,
    resolvedPath: null,
    assetUrl: ref.assetUrl ?? null,
    mimeType: ref.mimeType ?? null,
    sortOrder: countRows.length,
    createdAt: now,
    updatedAt: now
  })

  await markCorpusDirty(input.designSessionId)
  await invalidatePlanOnCorpusChange(input.designSessionId)
  return ref
}

export async function addLocalCorpusToCorpus(input: {
  username: string
  threadId: string
  designSessionId: string
  localPath: string
  name: string
  description: string
  kind?: 'file' | 'directory'
}): Promise<DraftReference> {
  const session = await getDesignSessionForUser(
    input.username,
    input.threadId,
    input.designSessionId
  )
  if (!session) throw AppError.notFound('Design session not found', 'design_session.not_found')
  if (session.status === 'launched') {
    throw AppError.badRequest(
      'Design session already launched; corpus is immutable',
      'design_session.launched'
    )
  }

  const description = input.description.trim()
  if (!description) {
    throw AppError.badRequest('Description is required', 'draft.reference_description_missing')
  }

  let resolvedPath: string
  try {
    resolvedPath = resolveLocalCorpusPath(input.localPath)
  } catch (error) {
    throw AppError.badRequest(
      error instanceof Error ? error.message : 'Invalid local corpus path',
      'draft.local_corpus.invalid_path'
    )
  }

  const inferredKind = inferReferenceKind(resolvedPath)
  const kind = input.kind ?? inferredKind
  if (kind === 'file') {
    try {
      assertLocalCorpusFileAllowed('file')
    } catch (error) {
      throw AppError.badRequest(
        error instanceof Error ? error.message : 'Single-file local corpus not allowed',
        'draft.local_corpus.file_not_allowed'
      )
    }
  }

  const ref: DraftReference = {
    id: `ref-${randomUUID()}`,
    source: 'local_corpus',
    name: input.name.trim() || resolvedPath.split('/').pop() || 'local-corpus',
    kind: kind === 'directory' ? 'directory' : inferredKind === 'directory' ? 'directory' : 'file',
    description,
    localPath: input.localPath.trim()
  }

  const now = nowSec()
  const db = getDb()
  const countRows = await db
    .select()
    .from(draftReferences)
    .where(eq(draftReferences.designSessionId, input.designSessionId))

  await db.insert(draftReferences).values({
    id: ref.id,
    designSessionId: input.designSessionId,
    source: ref.source,
    name: ref.name,
    kind: ref.kind,
    description: ref.description,
    attachmentId: null,
    localPath: ref.localPath ?? null,
    resolvedPath,
    assetUrl: null,
    mimeType: null,
    sortOrder: countRows.length,
    createdAt: now,
    updatedAt: now
  })

  await markCorpusDirty(input.designSessionId)
  await invalidatePlanOnCorpusChange(input.designSessionId)
  return ref
}

export async function updateCorpusItem(input: {
  username: string
  threadId: string
  designSessionId: string
  refId: string
  description?: string
  name?: string
}): Promise<DraftReference> {
  const session = await getDesignSessionForUser(
    input.username,
    input.threadId,
    input.designSessionId
  )
  if (!session) throw AppError.notFound('Design session not found', 'design_session.not_found')
  if (session.status === 'launched') {
    throw AppError.badRequest(
      'Design session already launched; corpus is immutable',
      'design_session.launched'
    )
  }

  const db = getDb()
  const rows = await db
    .select()
    .from(draftReferences)
    .where(
      and(
        eq(draftReferences.designSessionId, input.designSessionId),
        eq(draftReferences.id, input.refId)
      )
    )
    .limit(1)
  const row = rows[0]
  if (!row) throw AppError.notFound('Reference not found', 'draft.reference_not_found')

  const patch: Partial<DraftReferenceRow> = { updatedAt: nowSec() }
  const nextName =
    input.name !== undefined && row.source === 'local_corpus'
      ? input.name.trim() || row.name
      : row.name
  if (input.description !== undefined) {
    const nextDescription = input.description.trim()
    const refLike = {
      id: row.id,
      name: nextName,
      mimeType: row.mimeType ?? undefined,
      kind: row.kind as DraftReference['kind'],
      description: nextDescription
    }
    if (referenceDescriptionMissing(refLike)) {
      throw AppError.badRequest(
        formatReferenceDescriptionError([nextName]),
        'draft.reference_description_missing'
      )
    }
    patch.description = nextDescription
  }
  if (input.name !== undefined && row.source === 'local_corpus') {
    patch.name = nextName
  }

  await db
    .update(draftReferences)
    .set(patch)
    .where(
      and(
        eq(draftReferences.designSessionId, input.designSessionId),
        eq(draftReferences.id, input.refId)
      )
    )

  const updated = await db
    .select()
    .from(draftReferences)
    .where(eq(draftReferences.id, input.refId))
    .limit(1)

  await markCorpusDirty(input.designSessionId)
  await invalidatePlanOnCorpusChange(input.designSessionId)
  return rowToDraftReference(updated[0]!)
}

export async function removeCorpusItem(input: {
  username: string
  threadId: string
  designSessionId: string
  refId: string
}): Promise<void> {
  const session = await getDesignSessionForUser(
    input.username,
    input.threadId,
    input.designSessionId
  )
  if (!session) throw AppError.notFound('Design session not found', 'design_session.not_found')
  if (session.status === 'launched') {
    throw AppError.badRequest(
      'Design session already launched; corpus is immutable',
      'design_session.launched'
    )
  }

  const db = getDb()
  await db
    .delete(draftReferences)
    .where(
      and(
        eq(draftReferences.designSessionId, input.designSessionId),
        eq(draftReferences.id, input.refId)
      )
    )

  await markCorpusDirty(input.designSessionId)
  await invalidatePlanOnCorpusChange(input.designSessionId)
}

async function markCorpusDirty(designSessionId: string): Promise<void> {
  const db = getDb()
  const rows = await db
    .select({ corpusRevision: threadJobs.corpusRevision })
    .from(threadJobs)
    .where(eq(threadJobs.id, designSessionId))
    .limit(1)
  const row = rows[0]
  if (!row) return
  await db
    .update(threadJobs)
    .set({
      corpusRevision: (row.corpusRevision ?? 0) + 1,
      updatedAt: nowSec()
    })
    .where(eq(threadJobs.id, designSessionId))
}

export { isManifestFresh, referenceManifestStaleReason } from './corpus-sync'

export async function invalidatePlanOnCorpusChange(designSessionId: string): Promise<void> {
  const db = getDb()
  const sessionRows = await db
    .select()
    .from(threadJobs)
    .where(eq(threadJobs.id, designSessionId))
    .limit(1)
  const session = sessionRows[0]
  if (!session) return
  if (session.status !== 'plan_editing' && session.status !== 'planning') return

  const plan = await loadDesignPlan(db, designSessionId)
  if (!plan?.tasks?.length) return

  const corpus = await listReferenceCorpus(designSessionId)
  const corpusIds = new Set(corpus.map((item) => item.id))
  const missingIds = findPlanReferenceIdsMissingFromCorpus(plan, corpusIds)
  if (missingIds.length > 0) {
    const idErrors = missingIds.map((id) => `referenceId "${id}" is not in the current corpus`)
    await db
      .update(threadJobs)
      .set({
        lastError: idErrors.join('; '),
        updatedAt: nowSec()
      })
      .where(eq(threadJobs.id, designSessionId))
  }

  const cleared = clearPlanConfirmedFlags(plan)
  await saveDesignPlan(db, designSessionId, cleared)

  const phasePatch =
    session.phase === 'ready_to_launch'
      ? { phase: 'plan_edit' as const, status: 'plan_editing' as const }
      : {}

  await db
    .update(threadJobs)
    .set({ ...phasePatch, updatedAt: nowSec() })
    .where(eq(threadJobs.id, designSessionId))

  const job = await updateDesignSessionRow(designSessionId, { plan: cleared, ...phasePatch })
  if (job) {
    emitJobEvent(designSessionId, { event: 'job_snapshot', data: { job } })
  }
}

export async function freezeReferenceCorpus(input: {
  username: string
  threadId: string
  designSessionId: string
}): Promise<JobReferenceManifest> {
  const session = await getDesignSessionForUser(
    input.username,
    input.threadId,
    input.designSessionId
  )
  if (!session) throw AppError.notFound('Design session not found', 'design_session.not_found')

  const corpus = await listReferenceCorpus(input.designSessionId)
  assertCorpusDescriptionsReady(corpus)
  const sessionRows = await getDb()
    .select({ corpusRevision: threadJobs.corpusRevision })
    .from(threadJobs)
    .where(eq(threadJobs.id, input.designSessionId))
    .limit(1)
  const corpusRevision = sessionRows[0]?.corpusRevision ?? 0
  const nextRevision = (session.manifestRevision ?? 0) + 1
  const manifest = buildManifestFromCorpus({
    designSessionId: input.designSessionId,
    draftMessageId: session.draftMessageId,
    threadId: input.threadId,
    workspaceRoot: session.workspacePath,
    corpus,
    manifestRevision: nextRevision
  })

  const db = getDb()
  await db
    .update(threadJobs)
    .set({
      referenceManifestJson: serializeJobReferenceManifest(manifest),
      manifestRevision: nextRevision,
      frozenCorpusRevision: corpusRevision,
      updatedAt: nowSec()
    })
    .where(eq(threadJobs.id, input.designSessionId))

  const plan = await loadDesignPlan(db, input.designSessionId)
  if (plan?.tasks?.length) {
    const usedIds = [...collectFlatPlanReferenceIds(plan.tasks)]
    const idErrors = validateTaskReferenceIds(manifest, usedIds)
    if (idErrors.length > 0) {
      await invalidatePlanOnCorpusChange(input.designSessionId)
    } else {
      await invalidatePlanOnCorpusChange(input.designSessionId)
    }
  }

  return manifest
}

export async function loadFrozenManifest(
  designSessionId: string
): Promise<JobReferenceManifest | null> {
  const db = getDb()
  const rows = await db
    .select()
    .from(threadJobs)
    .where(eq(threadJobs.id, designSessionId))
    .limit(1)
  const row = rows[0]
  if (!row?.referenceManifestJson) return null
  return JSON.parse(row.referenceManifestJson) as JobReferenceManifest
}

export async function assertCorpusAttachmentReadable(
  threadId: string,
  attachmentId: string
): Promise<void> {
  const stored = readThreadAttachment(threadId, attachmentId)
  if (!stored) {
    throw AppError.notFound('Attachment not found', 'attachment.not_found')
  }
}
