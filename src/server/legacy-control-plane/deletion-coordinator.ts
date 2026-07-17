import { randomUUID } from 'crypto'
import { rm } from 'fs/promises'
import { and, eq, inArray } from 'drizzle-orm'
import { parseJobReferenceManifest } from '@shared/job-references'
import { getAppContext } from '../bootstrap'
import { getDb } from '../db'
import { deletionRequests, projects, threadJobs, threads } from '../db/schema'
import { attachmentDir } from '../data-paths'
import { AppError } from '../error'
import { closeConversationCursorRuntime } from '../agent-runtime/cursor-acp/stream-session-turn'
import {
  collectThreadPurgeTargets,
  purgeJobFilesystemStrict,
  purgeThreadFilesystemStrict,
  type ThreadPurgeTargets
} from '../retention/purge'
import { releaseJobCursorResources } from '../sandbox'
import { releaseWorkspaceLeaseForOwner } from './workspace-lease-store'
import { throwIfCurrentRequestAborted } from '../context/request-abort'
import { assertFrozenAttachmentId, FrozenIdError } from '../../shared/frozen-ids'
import { THREAD_KIND_TASK_SNAPSHOT } from '../threads/types'

export type DeletionEntityKind = 'thread_job' | 'thread' | 'project'

/** Legacy status kept for the partial unique index; mirrors in-progress vs terminal. */
export type DeletionRequestStatus = 'pending' | 'draining' | 'deleting' | 'completed' | 'failed'

export type DeletionPhase =
  | 'requested'
  | 'draining'
  | 'runtime_closed'
  | 'database_deleted'
  | 'filesystem_cleaned'
  | 'completed'

const INCOMPLETE_PHASES: DeletionPhase[] = [
  'requested',
  'draining',
  'runtime_closed',
  'database_deleted',
  'filesystem_cleaned'
]

export interface FrozenJobRuntimeIdentity {
  activeRunId: string | null
  executionLeaseOwner: string | null
  workspaceLeaseOwnerKind: 'thread_job'
  workspaceLeaseOwnerId: string
}

export interface DeletionFrozenSnapshot {
  runtime?: FrozenJobRuntimeIdentity | null
  draftMessageId?: string | null
  deleteOwningThread?: boolean
  childJobIds?: string[]
  childThreadIds?: string[]
}

export type CleanupTargets =
  | { kind: 'job'; threadId: string; jobId: string; attachmentIds?: string[] }
  | { kind: 'thread'; threadId: string; targets: ThreadPurgeTargets }
  | { kind: 'project' }

export interface LoadedDeletionRequest {
  id: string
  entityKind: DeletionEntityKind
  entityId: string
  username: string
  status: DeletionRequestStatus
  phase: DeletionPhase
  threadId: string | null
  projectId: string | null
  workspacePath: string | null
  frozenJson: string | null
  cleanupTargetsJson: string | null
  retryCount: number
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000)
}

function parseFrozenSnapshot(raw: string | null | undefined): DeletionFrozenSnapshot {
  if (!raw?.trim()) return {}
  try {
    return JSON.parse(raw) as DeletionFrozenSnapshot
  } catch {
    return {}
  }
}

function parseCleanupTargets(raw: string | null | undefined): CleanupTargets | null {
  if (!raw?.trim()) return null
  try {
    return JSON.parse(raw) as CleanupTargets
  } catch {
    return null
  }
}

function loadDeletionRequest(requestId: string): LoadedDeletionRequest {
  const row = getDb()
    .select()
    .from(deletionRequests)
    .where(eq(deletionRequests.id, requestId))
    .limit(1)
    .all()[0]
  if (!row) {
    throw new Error(`deletion_request.not_found:${requestId}`)
  }
  return {
    id: row.id,
    entityKind: row.entityKind as DeletionEntityKind,
    entityId: row.entityId,
    username: row.username,
    status: row.status as DeletionRequestStatus,
    phase: (row.phase as DeletionPhase) ?? 'requested',
    threadId: row.threadId ?? null,
    projectId: row.projectId ?? null,
    workspacePath: row.workspacePath ?? null,
    frozenJson: row.frozenJson ?? null,
    cleanupTargetsJson: row.cleanupTargetsJson ?? null,
    retryCount: row.retryCount ?? 0
  }
}

function findActiveDeletionRequest(
  entityKind: DeletionEntityKind,
  entityId: string
): { id: string } | null {
  const row = getDb()
    .select({ id: deletionRequests.id })
    .from(deletionRequests)
    .where(
      and(
        eq(deletionRequests.entityKind, entityKind),
        eq(deletionRequests.entityId, entityId),
        inArray(deletionRequests.phase, INCOMPLETE_PHASES)
      )
    )
    .limit(1)
    .all()[0]
  return row ?? null
}

async function freezeJobRuntimeIdentity(jobId: string): Promise<FrozenJobRuntimeIdentity> {
  const rows = await getDb()
    .select({
      activeRunId: threadJobs.activeRunId,
      executionLeaseOwner: threadJobs.executionLeaseOwner
    })
    .from(threadJobs)
    .where(eq(threadJobs.id, jobId))
    .limit(1)
  const row = rows[0]
  return {
    activeRunId: row?.activeRunId ?? null,
    executionLeaseOwner: row?.executionLeaseOwner ?? null,
    workspaceLeaseOwnerKind: 'thread_job',
    workspaceLeaseOwnerId: jobId
  }
}

export function isEntityDeletionBlocked(entityKind: DeletionEntityKind, entityId: string): boolean {
  const rows = getDb()
    .select({ id: deletionRequests.id })
    .from(deletionRequests)
    .where(
      and(
        eq(deletionRequests.entityKind, entityKind),
        eq(deletionRequests.entityId, entityId),
        inArray(deletionRequests.phase, INCOMPLETE_PHASES)
      )
    )
    .limit(1)
    .all()
  return rows.length > 0
}

export function isProjectDeletionBlocked(projectId: string): boolean {
  return isEntityDeletionBlocked('project', projectId)
}

export async function isThreadProjectDeletionBlocked(threadId: string): Promise<boolean> {
  if (isEntityDeletionBlocked('thread', threadId)) return true

  const pendingJobDeletion = getDb()
    .select({ id: deletionRequests.id })
    .from(deletionRequests)
    .where(
      and(
        eq(deletionRequests.entityKind, 'thread_job'),
        eq(deletionRequests.threadId, threadId),
        inArray(deletionRequests.phase, INCOMPLETE_PHASES)
      )
    )
    .limit(1)
    .all()
  if (pendingJobDeletion.length > 0) return true

  const rows = await getDb()
    .select({ projectId: threads.projectId })
    .from(threads)
    .where(eq(threads.id, threadId))
    .limit(1)
  const projectId = rows[0]?.projectId
  if (!projectId) {
    const pending = getDb()
      .select({ projectId: deletionRequests.projectId })
      .from(deletionRequests)
      .where(
        and(
          eq(deletionRequests.entityKind, 'thread'),
          eq(deletionRequests.entityId, threadId),
          inArray(deletionRequests.phase, INCOMPLETE_PHASES)
        )
      )
      .limit(1)
      .all()[0]
    if (pending?.projectId) {
      return isProjectDeletionBlocked(pending.projectId)
    }
    return false
  }
  return isProjectDeletionBlocked(projectId)
}

function createDeletionRequest(input: {
  entityKind: DeletionEntityKind
  entityId: string
  username: string
  phase?: DeletionPhase
  threadId?: string | null
  projectId?: string | null
  workspacePath?: string | null
  frozenJson?: string | null
  cleanupTargetsJson?: string | null
}): string {
  const existing = findActiveDeletionRequest(input.entityKind, input.entityId)
  if (existing) {
    return existing.id
  }

  const now = nowSec()
  const id = `del-${randomUUID()}`
  getDb()
    .insert(deletionRequests)
    .values({
      id,
      entityKind: input.entityKind,
      entityId: input.entityId,
      username: input.username,
      status: 'draining',
      phase: input.phase ?? 'requested',
      threadId: input.threadId ?? null,
      projectId: input.projectId ?? null,
      workspacePath: input.workspacePath ?? null,
      frozenJson: input.frozenJson ?? null,
      cleanupTargetsJson: input.cleanupTargetsJson ?? null,
      retryCount: 0,
      createdAt: now,
      updatedAt: now
    })
    .run()
  return id
}

async function updateDeletionPhase(
  requestId: string,
  phase: DeletionPhase,
  patch: {
    status?: DeletionRequestStatus
    lastError?: string | null
    retryCount?: number
    errorJson?: string | null
  } = {}
): Promise<void> {
  const next: Record<string, unknown> = {
    phase,
    updatedAt: nowSec()
  }
  if (phase === 'completed') {
    next.status = patch.status ?? 'completed'
  } else if (patch.status) {
    next.status = patch.status
  } else {
    next.status = 'draining'
  }
  if ('lastError' in patch) next.lastError = patch.lastError ?? null
  if ('retryCount' in patch && patch.retryCount !== undefined) next.retryCount = patch.retryCount
  if ('errorJson' in patch) next.errorJson = patch.errorJson ?? null

  getDb().update(deletionRequests).set(next).where(eq(deletionRequests.id, requestId)).run()
}

async function recordDeletionFailure(requestId: string, error: unknown): Promise<void> {
  const request = loadDeletionRequest(requestId)
  const message = error instanceof Error ? error.message : String(error)
  getDb()
    .update(deletionRequests)
    .set({
      status: 'failed',
      lastError: message,
      retryCount: request.retryCount + 1,
      errorJson: JSON.stringify({ message }),
      updatedAt: nowSec()
    })
    .where(eq(deletionRequests.id, requestId))
    .run()
}

async function recordFilesystemCleanupFailure(requestId: string, error: unknown): Promise<void> {
  const request = loadDeletionRequest(requestId)
  const message = error instanceof Error ? error.message : String(error)
  getDb()
    .update(deletionRequests)
    .set({
      lastError: message,
      retryCount: request.retryCount + 1,
      errorJson: JSON.stringify({ message }),
      updatedAt: nowSec()
    })
    .where(eq(deletionRequests.id, requestId))
    .run()
}

async function stopJobRuntimeByFrozenIdentity(
  jobId: string,
  frozen: FrozenJobRuntimeIdentity
): Promise<void> {
  const { isJobExecuting, abortActiveTurn, clearAbortController } = await import('./controls')
  const { cancelJobSandboxTurns } = await import('../sandbox')
  const { JOB_CANCELLED } = await import('../../shared/turn-errors.ts')
  const { clearExecutionLease } = await import('./repository')
  const { stopRunLifecycle } = await import('./run-lifecycle')
  const executionRuntime = getAppContext().executionRuntime

  if (isJobExecuting(jobId)) {
    executionRuntime.setControl(jobId, 'cancelling')
    abortActiveTurn(jobId, JOB_CANCELLED)
    clearAbortController(jobId)
    cancelJobSandboxTurns(jobId)
    executionRuntime.dropRuntime(jobId)
  }

  if (frozen.activeRunId) {
    await stopRunLifecycle(frozen.activeRunId, 'deleted', {}, { skipRelease: true })
    const { releaseWorkloadSlot } = await import('./workload-slot-store')
    await releaseWorkloadSlot(frozen.activeRunId, {
      reason: 'deleted',
      status: 'released',
      skipQueueAdvance: true
    }).catch(() => {})
  } else {
    const { getActiveRun, releaseWorkloadSlot } = await import('./workload-slot-store')
    const active = await getActiveRun('thread_job', jobId)
    if (active) {
      await stopRunLifecycle(active.runId, 'deleted', {}, { skipRelease: true })
      await releaseWorkloadSlot(active.runId, {
        reason: 'deleted',
        status: 'released',
        skipQueueAdvance: true
      }).catch(() => {})
    }
  }

  await clearExecutionLease(jobId)
  releaseWorkspaceLeaseForOwner('thread_job', jobId)
  await releaseJobCursorResources(jobId).catch(() => {})
}

async function ensureChildJobsDeleted(username: string, childJobIds: string[]): Promise<void> {
  for (const jobId of childJobIds) {
    const active = findActiveDeletionRequest('thread_job', jobId)
    if (active) {
      await executeDeletionRequest(active.id)
      continue
    }
    const jobExists = await getDb()
      .select({ id: threadJobs.id })
      .from(threadJobs)
      .where(and(eq(threadJobs.id, jobId), eq(threadJobs.username, username)))
      .limit(1)
    if (jobExists.length > 0) {
      await drainAndDeleteJob(username, jobId)
    }
  }
}

async function ensureChildThreadsDeleted(
  username: string,
  childThreadIds: string[]
): Promise<void> {
  for (const threadId of childThreadIds) {
    const active = findActiveDeletionRequest('thread', threadId)
    if (active) {
      await executeDeletionRequest(active.id)
      continue
    }
    const threadExists = await getDb()
      .select({ id: threads.id })
      .from(threads)
      .where(and(eq(threads.id, threadId), eq(threads.username, username)))
      .limit(1)
    if (threadExists.length > 0) {
      await drainAndDeleteThread(username, threadId)
    }
  }
}

async function deleteEntityDatabaseRows(request: LoadedDeletionRequest): Promise<void> {
  const db = getDb()
  if (request.entityKind === 'thread_job') {
    db.transaction((tx) => {
      tx.delete(threadJobs).where(eq(threadJobs.id, request.entityId)).run()
    })
    getAppContext().eventBus.clearJob(request.entityId)
    return
  }

  if (request.entityKind === 'thread') {
    db.transaction((tx) => {
      tx.delete(threads)
        .where(and(eq(threads.username, request.username), eq(threads.id, request.entityId)))
        .run()
    })
    return
  }

  if (request.entityKind === 'project') {
    db.transaction((tx) => {
      tx.delete(projects)
        .where(and(eq(projects.username, request.username), eq(projects.id, request.entityId)))
        .run()
    })
  }
}

async function purgeCleanupTargets(request: LoadedDeletionRequest): Promise<void> {
  const targets = parseCleanupTargets(request.cleanupTargetsJson)
  if (!targets || targets.kind === 'project') return

  const dataDir = getAppContext().dataDir
  if (targets.kind === 'job') {
    await purgeJobFilesystemStrictHook(dataDir, targets.threadId, targets.jobId)
    for (const attachmentId of targets.attachmentIds ?? []) {
      await rm(attachmentDir(dataDir, targets.threadId, attachmentId), {
        recursive: true,
        force: true
      })
    }
    return
  }

  await purgeThreadFilesystemStrictHook(dataDir, targets.threadId, targets.targets)
}

let purgeJobFilesystemStrictHook = purgeJobFilesystemStrict
let purgeThreadFilesystemStrictHook = purgeThreadFilesystemStrict

/** Test-only hook for fault injection. */
export function setDeletionPurgeHooksForTests(input: {
  purgeJob?: typeof purgeJobFilesystemStrict
  purgeThread?: typeof purgeThreadFilesystemStrict
}): void {
  purgeJobFilesystemStrictHook = input.purgeJob ?? purgeJobFilesystemStrict
  purgeThreadFilesystemStrictHook = input.purgeThread ?? purgeThreadFilesystemStrict
}

async function runPostDeletionHooks(request: LoadedDeletionRequest): Promise<void> {
  if (request.entityKind === 'thread_job') {
    const frozen = parseFrozenSnapshot(request.frozenJson)
    if (request.threadId && frozen.draftMessageId && !frozen.deleteOwningThread) {
      const { releaseDraftAfterJobDeleted } = await import('./draft-plan')
      await releaseDraftAfterJobDeleted(
        request.username,
        request.threadId,
        request.entityId,
        frozen.draftMessageId
      ).catch((error) => {
        console.warn('[deletion] failed to release draft after job delete', request.entityId, error)
      })
    }

    if (
      request.threadId &&
      frozen.deleteOwningThread &&
      !isEntityDeletionBlocked('thread', request.threadId)
    ) {
      await drainAndDeleteThread(request.username, request.threadId)
    }

    const { advanceExecutionQueue } = await import('./queue-coordinator')
    await advanceExecutionQueue(request.username).catch((error) => {
      console.warn('[deletion] advance queue after job delete failed', request.entityId, error)
    })
    return
  }

  if (request.entityKind === 'thread' && request.projectId) {
    const { touchProject } = await import('../projects/service')
    await touchProject(request.username, request.projectId)
  }
}

export async function executeDeletionRequest(requestId: string): Promise<void> {
  const request = loadDeletionRequest(requestId)
  if (request.phase === 'completed') {
    return
  }

  let phase = request.phase

  try {
    if (phase === 'requested' || phase === 'draining') {
      const frozen = parseFrozenSnapshot(request.frozenJson)

      if (request.entityKind === 'project' && frozen.childThreadIds?.length) {
        await ensureChildThreadsDeleted(request.username, frozen.childThreadIds)
      }

      if (request.entityKind === 'thread' && frozen.childJobIds?.length) {
        await ensureChildJobsDeleted(request.username, frozen.childJobIds)
      }

      if (request.entityKind === 'thread_job' && frozen.runtime) {
        await stopJobRuntimeByFrozenIdentity(request.entityId, frozen.runtime)
      }

      if (request.entityKind === 'thread' && request.threadId) {
        await closeConversationCursorRuntime(request.threadId)
      }

      throwIfCurrentRequestAborted()
      if (phase === 'requested') {
        await updateDeletionPhase(requestId, 'draining')
      }
      await updateDeletionPhase(requestId, 'runtime_closed')
      phase = 'runtime_closed'
    }

    if (phase === 'runtime_closed') {
      throwIfCurrentRequestAborted()
      await deleteEntityDatabaseRows(request)
      await updateDeletionPhase(requestId, 'database_deleted')
      phase = 'database_deleted'
    }

    if (phase === 'database_deleted') {
      throwIfCurrentRequestAborted()
      try {
        await purgeCleanupTargets(request)
      } catch (error) {
        await recordFilesystemCleanupFailure(requestId, error)
        throw error
      }
      await updateDeletionPhase(requestId, 'filesystem_cleaned')
      phase = 'filesystem_cleaned'
    }

    if (phase === 'filesystem_cleaned') {
      await runPostDeletionHooks(request)
      await updateDeletionPhase(requestId, 'completed', { status: 'completed' })
    }
  } catch (error) {
    const current = loadDeletionRequest(requestId)
    if (current.phase !== 'completed' && current.phase !== 'database_deleted') {
      await recordDeletionFailure(requestId, error)
    }
    throw error
  }
}

export async function drainAndDeleteJob(username: string, jobId: string): Promise<void> {
  const active = findActiveDeletionRequest('thread_job', jobId)
  if (active) {
    return executeDeletionRequest(active.id)
  }

  const job = getDb()
    .select()
    .from(threadJobs)
    .where(and(eq(threadJobs.id, jobId), eq(threadJobs.username, username)))
    .limit(1)
    .all()[0]
  if (!job) {
    throw AppError.notFound('Job not found', 'job.not_found')
  }

  const threadRows = await getDb()
    .select({ projectId: threads.projectId, threadKind: threads.threadKind })
    .from(threads)
    .where(eq(threads.id, job.threadId))
    .limit(1)
  const projectId = threadRows[0]?.projectId ?? null
  const frozen = await freezeJobRuntimeIdentity(jobId)
  const ownedAttachmentIds = collectJobOwnedAttachmentIds(job.referenceManifestJson)

  const requestId = await createDeletionRequest({
    entityKind: 'thread_job',
    entityId: jobId,
    username,
    threadId: job.threadId,
    projectId,
    workspacePath: job.workspacePath ?? null,
    frozenJson: JSON.stringify({
      runtime: frozen,
      draftMessageId: job.draftMessageId,
      deleteOwningThread: threadRows[0]?.threadKind === THREAD_KIND_TASK_SNAPSHOT
    }),
    cleanupTargetsJson: JSON.stringify({
      kind: 'job',
      threadId: job.threadId,
      jobId,
      attachmentIds: ownedAttachmentIds
    } satisfies CleanupTargets)
  })

  await executeDeletionRequest(requestId)
}

function collectJobOwnedAttachmentIds(rawManifest: string | null | undefined): string[] {
  const manifest = parseJobReferenceManifest(rawManifest)
  if (!manifest) return []
  const ids = new Set<string>()
  for (const reference of manifest.references) {
    if (reference.storageOwner !== 'job' || !reference.attachmentId) continue
    try {
      ids.add(assertFrozenAttachmentId(reference.attachmentId))
    } catch (error) {
      if (error instanceof FrozenIdError) continue
      throw error
    }
  }
  return [...ids]
}

/**
 * Atomically claim deletion of a pre-launch planning Job. The launch transaction
 * checks the durable deletion intent, so either deletion wins or launch wins; a
 * Job can never cross into the task list after this function claims it.
 */
export async function drainAndDeletePlanningJob(
  username: string,
  jobId: string
): Promise<{ mode: 'deleted' | 'launched' }> {
  const db = getDb()
  const claim = db.transaction(() => {
    const active = findActiveDeletionRequest('thread_job', jobId)
    if (active) {
      return { kind: 'delete' as const, requestId: active.id }
    }

    const job = db
      .select()
      .from(threadJobs)
      .where(and(eq(threadJobs.id, jobId), eq(threadJobs.username, username)))
      .limit(1)
      .all()[0]
    if (!job) return { kind: 'missing' as const }
    if (job.planConfirmedAt != null) return { kind: 'launched' as const }

    const projectId =
      db
        .select({ projectId: threads.projectId })
        .from(threads)
        .where(eq(threads.id, job.threadId))
        .limit(1)
        .all()[0]?.projectId ?? null

    const requestId = createDeletionRequest({
      entityKind: 'thread_job',
      entityId: jobId,
      username,
      threadId: job.threadId,
      projectId,
      workspacePath: job.workspacePath ?? null,
      frozenJson: JSON.stringify({
        runtime: {
          activeRunId: job.activeRunId ?? null,
          executionLeaseOwner: job.executionLeaseOwner ?? null,
          workspaceLeaseOwnerKind: 'thread_job',
          workspaceLeaseOwnerId: jobId
        },
        draftMessageId: job.draftMessageId
      } satisfies DeletionFrozenSnapshot),
      cleanupTargetsJson: JSON.stringify({
        kind: 'job',
        threadId: job.threadId,
        jobId,
        attachmentIds: []
      } satisfies CleanupTargets)
    })
    return { kind: 'delete' as const, requestId }
  })

  if (claim.kind === 'missing') {
    throw AppError.notFound('Job not found', 'job.not_found')
  }
  if (claim.kind === 'launched') return { mode: 'launched' }

  await executeDeletionRequest(claim.requestId)
  return { mode: 'deleted' }
}

export async function drainAndDeleteThread(username: string, threadId: string): Promise<void> {
  const active = findActiveDeletionRequest('thread', threadId)
  if (active) {
    return executeDeletionRequest(active.id)
  }

  const threadRows = await getDb()
    .select()
    .from(threads)
    .where(and(eq(threads.username, username), eq(threads.id, threadId)))
    .limit(1)
  const existing = threadRows[0]
  if (!existing) {
    throw AppError.notFound('Thread not found', 'thread.not_found')
  }

  const db = getDb()
  const jobRows = await db
    .select({ id: threadJobs.id })
    .from(threadJobs)
    .where(and(eq(threadJobs.threadId, threadId), eq(threadJobs.username, username)))
  const purgeTargets = await collectThreadPurgeTargets(db, threadId)

  const requestId = await createDeletionRequest({
    entityKind: 'thread',
    entityId: threadId,
    username,
    threadId,
    projectId: existing.projectId,
    frozenJson: JSON.stringify({
      childJobIds: jobRows.map((row) => row.id)
    } satisfies DeletionFrozenSnapshot),
    cleanupTargetsJson: JSON.stringify({
      kind: 'thread',
      threadId,
      targets: purgeTargets
    } satisfies CleanupTargets)
  })

  await executeDeletionRequest(requestId)
}

export async function drainAndDeleteProject(username: string, projectId: string): Promise<void> {
  const active = findActiveDeletionRequest('project', projectId)
  if (active) {
    return executeDeletionRequest(active.id)
  }

  const projectRows = await getDb()
    .select()
    .from(projects)
    .where(and(eq(projects.username, username), eq(projects.id, projectId)))
    .limit(1)
  const existing = projectRows[0]
  if (!existing) {
    throw AppError.notFound('Project not found', 'project.not_found')
  }

  const threadRows = await getDb()
    .select({ id: threads.id })
    .from(threads)
    .where(and(eq(threads.projectId, projectId), eq(threads.username, username)))

  const requestId = await createDeletionRequest({
    entityKind: 'project',
    entityId: projectId,
    username,
    projectId,
    frozenJson: JSON.stringify({
      childThreadIds: threadRows.map((row) => row.id)
    } satisfies DeletionFrozenSnapshot),
    cleanupTargetsJson: JSON.stringify({ kind: 'project' } satisfies CleanupTargets)
  })

  await executeDeletionRequest(requestId)
}

export async function resumePendingDeletionRequestsOnStartup(): Promise<void> {
  const rows = await getDb()
    .select({ id: deletionRequests.id })
    .from(deletionRequests)
    .where(and(inArray(deletionRequests.phase, INCOMPLETE_PHASES)))

  const errors: Error[] = []
  for (const row of rows) {
    try {
      await executeDeletionRequest(row.id)
    } catch (error) {
      console.warn('[deletion] startup janitor failed', row.id, error)
      errors.push(new Error(`deletion request ${row.id}`, { cause: error }))
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, 'Failed to resume pending deletion requests')
  }
}

export function resetDeletionCoordinatorForTests(): void {
  getDb().delete(deletionRequests).run()
}
