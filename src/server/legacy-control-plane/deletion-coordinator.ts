import { randomUUID } from 'crypto'
import { and, eq, inArray, or } from 'drizzle-orm'
import { getAppContext } from '../bootstrap'
import { getDb } from '../db'
import { deletionRequests, projects, threadJobs, threads } from '../db/schema'
import { AppError } from '../error'
import { closeConversationCursorRuntime } from '../agent-runtime/cursor-acp/stream-session-turn'
import { purgeJobFilesystem, collectThreadPurgeTargets, purgeThreadFilesystem } from '../retention/purge'
import { releaseJobCursorResources } from '../sandbox'
import { getUserJob } from './service'
import { releaseWorkspaceLeaseForOwner } from './workspace-lease-store'

export type DeletionEntityKind = 'thread_job' | 'thread' | 'project'
export type DeletionRequestStatus = 'pending' | 'draining' | 'deleting' | 'completed' | 'failed'

export interface FrozenJobRuntimeIdentity {
  activeRunId: string | null
  executionLeaseOwner: string | null
  workspaceLeaseOwnerKind: 'thread_job'
  workspaceLeaseOwnerId: string
}

export interface FilesystemCleanupRecord {
  kind: 'job' | 'thread'
  threadId: string
  jobId?: string
  targetsJson?: string
  lastError?: string
  attempts: number
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000)
}

function parseFilesystemCleanup(raw: string | null | undefined): FilesystemCleanupRecord[] {
  if (!raw?.trim()) return []
  try {
    const parsed = JSON.parse(raw) as FilesystemCleanupRecord[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
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

export function isEntityDeletionBlocked(
  entityKind: DeletionEntityKind,
  entityId: string
): boolean {
  const rows = getDb()
    .select({ id: deletionRequests.id })
    .from(deletionRequests)
    .where(
      and(
        eq(deletionRequests.entityKind, entityKind),
        eq(deletionRequests.entityId, entityId),
        inArray(deletionRequests.status, ['pending', 'draining', 'deleting'])
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
  const rows = await getDb()
    .select({ projectId: threads.projectId })
    .from(threads)
    .where(eq(threads.id, threadId))
    .limit(1)
  const projectId = rows[0]?.projectId
  if (!projectId) return false
  return isProjectDeletionBlocked(projectId)
}

async function upsertDeletionRequest(input: {
  entityKind: DeletionEntityKind
  entityId: string
  username: string
  status: DeletionRequestStatus
  frozenJson?: string | null
  filesystemCleanupJson?: string | null
  errorJson?: string | null
}): Promise<string> {
  const db = getDb()
  const now = nowSec()
  const existing = db
    .select({ id: deletionRequests.id })
    .from(deletionRequests)
    .where(
      and(
        eq(deletionRequests.entityKind, input.entityKind),
        eq(deletionRequests.entityId, input.entityId),
        inArray(deletionRequests.status, ['pending', 'draining', 'deleting'])
      )
    )
    .limit(1)
    .all()[0]

  if (existing) {
    db.update(deletionRequests)
      .set({
        status: input.status,
        frozenJson: input.frozenJson ?? null,
        filesystemCleanupJson: input.filesystemCleanupJson ?? null,
        errorJson: input.errorJson ?? null,
        updatedAt: now
      })
      .where(eq(deletionRequests.id, existing.id))
      .run()
    return existing.id
  }

  const id = `del-${randomUUID()}`
  db.insert(deletionRequests)
    .values({
      id,
      entityKind: input.entityKind,
      entityId: input.entityId,
      username: input.username,
      status: input.status,
      frozenJson: input.frozenJson ?? null,
      filesystemCleanupJson: input.filesystemCleanupJson ?? null,
      errorJson: input.errorJson ?? null,
      createdAt: now,
      updatedAt: now
    })
    .run()
  return id
}

async function updateDeletionStatus(
  requestId: string,
  status: DeletionRequestStatus,
  patch: {
    frozenJson?: string | null
    filesystemCleanupJson?: string | null
    errorJson?: string | null
  } = {}
): Promise<void> {
  const next: Record<string, unknown> = {
    status,
    updatedAt: nowSec()
  }
  if ('frozenJson' in patch) next.frozenJson = patch.frozenJson ?? null
  if ('filesystemCleanupJson' in patch) next.filesystemCleanupJson = patch.filesystemCleanupJson ?? null
  if ('errorJson' in patch) next.errorJson = patch.errorJson ?? null

  getDb()
    .update(deletionRequests)
    .set(next)
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

async function deleteJobDatabaseRow(jobId: string): Promise<void> {
  const db = getDb()
  db.transaction((tx) => {
    tx.delete(threadJobs).where(eq(threadJobs.id, jobId)).run()
  })
}

async function recordFilesystemCleanupFailure(
  requestId: string,
  record: FilesystemCleanupRecord,
  error: unknown
): Promise<void> {
  const rows = await getDb()
    .select({ filesystemCleanupJson: deletionRequests.filesystemCleanupJson })
    .from(deletionRequests)
    .where(eq(deletionRequests.id, requestId))
    .limit(1)
  const existing = parseFilesystemCleanup(rows[0]?.filesystemCleanupJson)
  const message = error instanceof Error ? error.message : String(error)
  existing.push({
    ...record,
    lastError: message,
    attempts: (record.attempts ?? 0) + 1
  })
  await updateDeletionStatus(requestId, 'completed', {
    filesystemCleanupJson: JSON.stringify(existing)
  })
}

export async function drainAndDeleteJob(username: string, jobId: string): Promise<void> {
  const job = await getUserJob(username, jobId)
  if (!job) throw AppError.notFound('Job not found', 'job.not_found')

  const requestId = await upsertDeletionRequest({
    entityKind: 'thread_job',
    entityId: jobId,
    username,
    status: 'draining'
  })

  const threadId = job.threadId
  const draftMessageId = job.draftMessageId

  try {
    const frozen = await freezeJobRuntimeIdentity(jobId)
    await updateDeletionStatus(requestId, 'draining', {
      frozenJson: JSON.stringify(frozen)
    })

    await stopJobRuntimeByFrozenIdentity(jobId, frozen)

    await updateDeletionStatus(requestId, 'deleting', {
      frozenJson: JSON.stringify(frozen)
    })

    const ctx = getAppContext()
    await deleteJobDatabaseRow(jobId)
    ctx.eventBus.clearJob(jobId)

    try {
      await purgeJobFilesystem(ctx.dataDir, threadId, jobId)
    } catch (error) {
      await recordFilesystemCleanupFailure(
        requestId,
        { kind: 'job', threadId, jobId, attempts: 0 },
        error
      )
    }

    const { releaseDraftAfterJobDeleted } = await import('./draft-plan')
    await releaseDraftAfterJobDeleted(username, threadId, jobId, draftMessageId).catch((error) => {
      console.warn('[deletion] failed to release draft after job delete', jobId, error)
    })

    const { advanceExecutionQueue } = await import('./queue-coordinator')
    await advanceExecutionQueue(username).catch((error) => {
      console.warn('[deletion] advance queue after job delete failed', jobId, error)
    })

    await updateDeletionStatus(requestId, 'completed')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await updateDeletionStatus(requestId, 'failed', { errorJson: JSON.stringify({ message }) })
    throw error
  }
}

export async function drainAndDeleteThread(username: string, threadId: string): Promise<void> {
  const threadRows = await getDb()
    .select()
    .from(threads)
    .where(and(eq(threads.username, username), eq(threads.id, threadId)))
    .limit(1)
  const existing = threadRows[0]
  if (!existing) throw AppError.notFound('Thread not found', 'thread.not_found')

  const requestId = await upsertDeletionRequest({
    entityKind: 'thread',
    entityId: threadId,
    username,
    status: 'draining'
  })

  try {
    const jobRows = await getDb()
      .select({ id: threadJobs.id })
      .from(threadJobs)
      .where(and(eq(threadJobs.threadId, threadId), eq(threadJobs.username, username)))

    for (const row of jobRows) {
      await drainAndDeleteJob(username, row.id)
    }

    await updateDeletionStatus(requestId, 'deleting')

    const db = getDb()
    const purgeTargets = await collectThreadPurgeTargets(db, threadId)
    db.transaction((tx) => {
      tx.delete(threads)
        .where(and(eq(threads.username, username), eq(threads.id, threadId)))
        .run()
    })

    const dataDir = getAppContext().dataDir
    try {
      await purgeThreadFilesystem(dataDir, threadId, purgeTargets)
    } catch (error) {
      await recordFilesystemCleanupFailure(
        requestId,
        {
          kind: 'thread',
          threadId,
          targetsJson: JSON.stringify(purgeTargets),
          attempts: 0
        },
        error
      )
    }

    await closeConversationCursorRuntime(threadId).catch((error) => {
      console.warn('[deletion] failed to close cursor runtime for thread', threadId, error)
    })

    const { touchProject } = await import('../projects/service')
    await touchProject(username, existing.projectId)
    await updateDeletionStatus(requestId, 'completed')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await updateDeletionStatus(requestId, 'failed', { errorJson: JSON.stringify({ message }) })
    throw error
  }
}

export async function drainAndDeleteProject(username: string, projectId: string): Promise<void> {
  const projectRows = await getDb()
    .select()
    .from(projects)
    .where(and(eq(projects.username, username), eq(projects.id, projectId)))
    .limit(1)
  const existing = projectRows[0]
  if (!existing) throw AppError.notFound('Project not found', 'project.not_found')

  const requestId = await upsertDeletionRequest({
    entityKind: 'project',
    entityId: projectId,
    username,
    status: 'draining'
  })

  try {
    const threadRows = await getDb()
      .select({ id: threads.id })
      .from(threads)
      .where(and(eq(threads.projectId, projectId), eq(threads.username, username)))

    for (const row of threadRows) {
      await drainAndDeleteThread(username, row.id)
    }

    await updateDeletionStatus(requestId, 'deleting')
    getDb()
      .transaction((tx) => {
        tx.delete(projects)
          .where(and(eq(projects.username, username), eq(projects.id, projectId)))
          .run()
      })
    await updateDeletionStatus(requestId, 'completed')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await updateDeletionStatus(requestId, 'failed', { errorJson: JSON.stringify({ message }) })
    throw error
  }
}

export async function resumePendingDeletionRequestsOnStartup(): Promise<void> {
  const rows = await getDb()
    .select()
    .from(deletionRequests)
    .where(
      or(
        eq(deletionRequests.status, 'pending'),
        eq(deletionRequests.status, 'draining'),
        eq(deletionRequests.status, 'deleting')
      )
    )

  for (const row of rows) {
    try {
      if (row.entityKind === 'thread_job') {
        await drainAndDeleteJob(row.username, row.entityId)
      } else if (row.entityKind === 'thread') {
        await drainAndDeleteThread(row.username, row.entityId)
      } else if (row.entityKind === 'project') {
        await drainAndDeleteProject(row.username, row.entityId)
      }
    } catch (error) {
      console.warn('[deletion] startup janitor failed', row.entityKind, row.entityId, error)
    }
  }

  const cleanupRows = await getDb()
    .select()
    .from(deletionRequests)
    .where(eq(deletionRequests.status, 'completed'))

  const dataDir = getAppContext().dataDir
  for (const row of cleanupRows) {
    const pending = parseFilesystemCleanup(row.filesystemCleanupJson)
    if (pending.length === 0) continue
    const remaining: FilesystemCleanupRecord[] = []
    for (const item of pending) {
      try {
        if (item.kind === 'job' && item.jobId) {
          await purgeJobFilesystem(dataDir, item.threadId, item.jobId)
        } else if (item.kind === 'thread') {
          const targets = item.targetsJson
            ? (JSON.parse(item.targetsJson) as Awaited<ReturnType<typeof collectThreadPurgeTargets>>)
            : { designSessionIds: [], messageIds: [] }
          await purgeThreadFilesystem(dataDir, item.threadId, targets)
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        remaining.push({ ...item, lastError: message, attempts: item.attempts + 1 })
      }
    }
    if (remaining.length > 0) {
      getDb()
        .update(deletionRequests)
        .set({
          filesystemCleanupJson: JSON.stringify(remaining),
          updatedAt: nowSec()
        })
        .where(eq(deletionRequests.id, row.id))
        .run()
    } else {
      getDb()
        .update(deletionRequests)
        .set({ filesystemCleanupJson: null, updatedAt: nowSec() })
        .where(eq(deletionRequests.id, row.id))
        .run()
    }
  }
}

export function resetDeletionCoordinatorForTests(): void {
  getDb().delete(deletionRequests).run()
}
