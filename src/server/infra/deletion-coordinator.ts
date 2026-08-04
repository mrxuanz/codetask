import { randomUUID } from 'crypto'
import { rm } from 'fs/promises'
import { and, eq, inArray } from 'drizzle-orm'
import { parseJobReferenceManifest } from '../../shared/job-references.ts'
import { getAppContext } from '../bootstrap'
import { getDb } from '../db'
import { deletionRequests, projects } from '../db/schema'

import { attachmentDir } from '../data-paths'
import { AppError } from '../error'
import { closeConversationCursorRuntime } from '../agent-runtime/cursor-acp/stream-session-turn'
import { removeThreadAttachmentsDir } from '../retention/janitor'
import { releaseOwnerAssetReferences } from '../assets/registry'
import {
  collectThreadPurgeTargets,
  purgeJobFilesystemStrict,
  purgeThreadFilesystemStrict,
  type ThreadPurgeTargets
} from '../retention/purge'
import { releaseWorkspaceLeaseForOwner } from './workspace-lease-store.js'
import { throwIfCurrentRequestAborted } from '../context/request-abort'
import { assertFrozenAttachmentId, FrozenIdError } from '../../shared/frozen-ids'

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
  workspaceLeaseOwnerKind: 'thread_job' | 'job-run'
  workspaceLeaseOwnerId: string
}

export interface DeletionFrozenSnapshot {
  runtime?: FrozenJobRuntimeIdentity | null
  deleteOwningThread?: boolean
  childJobIds?: string[]
  /** Execution module `jobs.id` rows owned by a project. */
  childExecutionJobIds?: string[]
  childThreadIds?: string[]
  /** Conversation module `conversation_threads.id` rows owned by a project. */
  childConversationIds?: string[]
  /** Design module `drafts.id` rows owned by a project. */
  childDraftIds?: string[]
  /** Design module `planning_sessions.id` rows owned by a project. */
  childPlanningSessionIds?: string[]
}

export type CleanupTargets =
  | { kind: 'job'; threadId: string; jobId: string; attachmentIds?: string[] }
  | { kind: 'thread'; threadId: string; targets: ThreadPurgeTargets }
  | { kind: 'project'; conversationIds?: string[] }

export interface LoadedDeletionRequest {
  id: string
  entityKind: DeletionEntityKind
  entityId: string
  actorId: string
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
    actorId: row.actorId,
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
  const client = sqliteClient()
  let activeRunId: string | null = null
  if (client && tableExists(client, 'jobs')) {
    const row = client
      .prepare(`SELECT current_run_id AS currentRunId FROM jobs WHERE id = ? LIMIT 1`)
      .get(jobId) as { currentRunId: string | null } | undefined
    activeRunId = row?.currentRunId ?? null
  }
  const ownerKind: FrozenJobRuntimeIdentity['workspaceLeaseOwnerKind'] =
    client && tableExists(client, 'jobs') ? 'job-run' : 'thread_job'
  return {
    activeRunId,
    executionLeaseOwner: null,
    workspaceLeaseOwnerKind: ownerKind,
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

  const rows = getConversationProjectId(threadId)
  const projectId = rows
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
  actorId: string
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
      actorId: input.actorId,
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
  const { cancelJobSandboxTurns, releaseJobCursorResources } =
    await import('../sandbox/orchestrator')
  const { JOB_CANCELLED } = await import('../../shared/turn-errors.ts')
  const executionRuntime = getAppContext().executionRuntime

  if (executionRuntime.isLoopActive(jobId) || executionRuntime.get(jobId)) {
    executionRuntime.setControl(jobId, 'cancelling')
    executionRuntime.abortActiveTurn(jobId, JOB_CANCELLED)
    executionRuntime.clearAbortController(jobId)
    cancelJobSandboxTurns(jobId)
    executionRuntime.dropRuntime(jobId)
  } else {
    cancelJobSandboxTurns(jobId)
  }

  const db = getDb()
  const client = sqliteClient() ?? (db as { $client?: import('better-sqlite3').Database }).$client
  const now = Date.now()
  let runId = frozen.activeRunId
  if (!runId && client) {
    const row = client
      .prepare(
        `SELECT id FROM execution_runs WHERE job_id = ? AND status = 'active' ORDER BY started_at DESC LIMIT 1`
      )
      .get(jobId) as { id: string } | undefined
    runId = row?.id ?? null
  }
  if (runId && client) {
    client
      .prepare(
        `UPDATE execution_runs SET status = 'released', released_at = ?, release_reason = 'deleted', updated_at = ?
         WHERE id = ? AND status IN ('active', 'stopping')`
      )
      .run(now, now, runId)
    client
      .prepare(
        `UPDATE execution_pool_slots SET
          status = 'free', run_id = NULL, lease_owner = NULL, lease_expires_at = NULL, released_at = ?
         WHERE run_id = ?`
      )
      .run(now, runId)
    client
      .prepare(
        `UPDATE workspace_leases SET status = 'released', released_at = ?
         WHERE run_id = ? AND status = 'active'`
      )
      .run(now, runId)
  }

  if (client) {
    try {
      client
        .prepare(`UPDATE jobs SET current_run_id = NULL, updated_at = ? WHERE id = ?`)
        .run(now, jobId)
    } catch {
      // ignore
    }
  }

  releaseWorkspaceLeaseForOwner('job-run', jobId)
  releaseWorkspaceLeaseForOwner('thread_job', jobId)
  await releaseJobCursorResources(jobId).catch(() => {})
}

async function ensureChildJobsDeleted(actorId: string, childJobIds: string[]): Promise<void> {
  for (const jobId of childJobIds) {
    const active = findActiveDeletionRequest('thread_job', jobId)
    if (active) {
      await executeDeletionRequest(active.id)
      continue
    }
    if (readExecutionJobRow(jobId, actorId)) {
      await drainAndDeleteJob(actorId, jobId)
    }
  }
}

function sqliteClient(): import('better-sqlite3').Database | null {
  const db = getDb()
  return (db as { $client?: import('better-sqlite3').Database }).$client ?? null
}

function tableExists(client: import('better-sqlite3').Database, name: string): boolean {
  const row = client
    .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(name) as { 1: number } | undefined
  return Boolean(row)
}

function readExecutionJobRow(
  jobId: string,
  actorId: string
): {
  id: string
  projectId: string
  workspaceRoot: string
  referenceManifestJson: string | null
} | null {
  const client = sqliteClient()
  if (!client || !tableExists(client, 'jobs')) return null
  const row = client
    .prepare(
      `SELECT j.id AS id, j.project_id AS projectId, j.workspace_root AS workspaceRoot,
              js.reference_manifest_json AS referenceManifestJson
       FROM jobs j
       LEFT JOIN job_snapshots js ON js.job_id = j.id
       WHERE j.id = ? AND j.actor_id = ?
       LIMIT 1`
    )
    .get(jobId, actorId) as
    | {
        id: string
        projectId: string
        workspaceRoot: string
        referenceManifestJson: string | null
      }
    | undefined
  return row ?? null
}

/** Force-delete Execution `jobs` rows for a project (cascade cleans snapshots/tree/work). */
async function ensureProjectExecutionJobsDeleted(
  actorId: string,
  projectId: string,
  jobIds?: string[]
): Promise<void> {
  const client = sqliteClient()
  if (!client) return

  const ids =
    jobIds ??
    (
      client
        .prepare(`SELECT id FROM jobs WHERE project_id = ? AND actor_id = ?`)
        .all(projectId, actorId) as Array<{ id: string }>
    ).map((row) => row.id)

  for (const jobId of ids) {
    await stopJobRuntimeByFrozenIdentity(jobId, {
      activeRunId: null,
      executionLeaseOwner: null,
      workspaceLeaseOwnerKind: 'job-run',
      workspaceLeaseOwnerId: jobId
    }).catch(() => {})
    releaseWorkspaceLeaseForOwner('job-run', jobId)
    client.prepare(`DELETE FROM jobs WHERE id = ? AND actor_id = ?`).run(jobId, actorId)
  }
}

async function ensureChildThreadsDeleted(actorId: string, childThreadIds: string[]): Promise<void> {
  for (const threadId of childThreadIds) {
    const active = findActiveDeletionRequest('thread', threadId)
    if (active) {
      await executeDeletionRequest(active.id)
      continue
    }
    const threadExists = conversationExists(threadId, actorId)
    if (threadExists) {
      await drainAndDeleteThread(actorId, threadId)
    }
  }
}

function listProjectConversationIds(projectId: string): string[] {
  const client = sqliteClient()
  if (!client || !tableExists(client, 'conversation_threads')) return []
  return (
    client
      .prepare(`SELECT id FROM conversation_threads WHERE project_id = ?`)
      .all(projectId) as Array<{ id: string }>
  ).map((row) => row.id)
}

function getConversationProjectId(conversationId: string): string | null {
  const client = sqliteClient()
  if (!client || !tableExists(client, 'conversation_threads')) return null
  const row = client
    .prepare(`SELECT project_id AS projectId FROM conversation_threads WHERE id = ? LIMIT 1`)
    .get(conversationId) as { projectId: string } | undefined
  return row?.projectId ?? null
}

function getOwnedConversation(
  conversationId: string,
  actorId: string
): { id: string; projectId: string } | null {
  const client = sqliteClient()
  if (!client || !tableExists(client, 'conversation_threads')) return null
  const row = client
    .prepare(
      `SELECT id, project_id AS projectId
         FROM conversation_threads
        WHERE id = ? AND actor_id = ?
        LIMIT 1`
    )
    .get(conversationId, actorId) as { id: string; projectId: string } | undefined
  return row ?? null
}

function conversationExists(conversationId: string, actorId: string): boolean {
  return getOwnedConversation(conversationId, actorId) !== null
}

function deleteConversationRow(conversationId: string, actorId: string): void {
  const client = sqliteClient()
  if (!client || !tableExists(client, 'conversation_threads')) return
  client
    .prepare(`DELETE FROM conversation_threads WHERE id = ? AND actor_id = ?`)
    .run(conversationId, actorId)
}

function listProjectDraftIds(projectId: string, actorId: string): string[] {
  const client = sqliteClient()
  if (!client || !tableExists(client, 'drafts')) return []
  return (
    client
      .prepare(`SELECT id FROM drafts WHERE project_id = ? AND actor_id = ?`)
      .all(projectId, actorId) as Array<{ id: string }>
  ).map((row) => row.id)
}

function listProjectPlanningSessionIds(projectId: string, actorId: string): string[] {
  const client = sqliteClient()
  if (!client || !tableExists(client, 'planning_sessions')) return []
  return (
    client
      .prepare(`SELECT id FROM planning_sessions WHERE project_id = ? AND actor_id = ?`)
      .all(projectId, actorId) as Array<{ id: string }>
  ).map((row) => row.id)
}

/**
 * Delete Design + Conversation aggregates owned by a project.
 * Order matters: job_handoffs → planning_sessions → drafts → conversations
 * (planning_sessions.source_draft_id and job_handoffs lack ON DELETE CASCADE).
 */
async function ensureProjectOwnedAggregatesDeleted(input: {
  actorId: string
  projectId: string
  childConversationIds?: string[]
  childDraftIds?: string[]
  childPlanningSessionIds?: string[]
}): Promise<void> {
  const client = sqliteClient()
  if (!client) return

  const conversationIds = input.childConversationIds ?? listProjectConversationIds(input.projectId)
  const draftIds = input.childDraftIds ?? listProjectDraftIds(input.projectId, input.actorId)
  const planningSessionIds =
    input.childPlanningSessionIds ?? listProjectPlanningSessionIds(input.projectId, input.actorId)

  for (const conversationId of conversationIds) {
    await closeConversationCursorRuntime(conversationId).catch(() => {})
  }

  for (const conversationId of conversationIds) {
    releaseOwnerAssetReferences(client, 'conversation', conversationId)
  }

  if (planningSessionIds.length > 0 && tableExists(client, 'job_handoffs')) {
    const placeholders = planningSessionIds.map(() => '?').join(',')
    client
      .prepare(`DELETE FROM job_handoffs WHERE planning_session_id IN (${placeholders})`)
      .run(...planningSessionIds)
  }

  if (planningSessionIds.length > 0 && tableExists(client, 'planning_sessions')) {
    const placeholders = planningSessionIds.map(() => '?').join(',')
    client
      .prepare(`DELETE FROM planning_sessions WHERE id IN (${placeholders})`)
      .run(...planningSessionIds)
  } else if (tableExists(client, 'planning_sessions')) {
    client
      .prepare(`DELETE FROM planning_sessions WHERE project_id = ? AND actor_id = ?`)
      .run(input.projectId, input.actorId)
  }

  if (draftIds.length > 0 && tableExists(client, 'drafts')) {
    const placeholders = draftIds.map(() => '?').join(',')
    client.prepare(`DELETE FROM drafts WHERE id IN (${placeholders})`).run(...draftIds)
  } else if (tableExists(client, 'drafts')) {
    client
      .prepare(`DELETE FROM drafts WHERE project_id = ? AND actor_id = ?`)
      .run(input.projectId, input.actorId)
  }

  if (conversationIds.length > 0 && tableExists(client, 'conversation_threads')) {
    const placeholders = conversationIds.map(() => '?').join(',')
    client
      .prepare(`DELETE FROM conversation_threads WHERE id IN (${placeholders})`)
      .run(...conversationIds)
  } else if (tableExists(client, 'conversation_threads')) {
    client.prepare(`DELETE FROM conversation_threads WHERE project_id = ?`).run(input.projectId)
  }
}

async function deleteEntityDatabaseRows(request: LoadedDeletionRequest): Promise<void> {
  const db = getDb()
  if (request.entityKind === 'thread_job') {
    const client = sqliteClient()
    client
      ?.prepare(`DELETE FROM jobs WHERE id = ? AND actor_id = ?`)
      .run(request.entityId, request.actorId)
    return
  }

  if (request.entityKind === 'thread') {
    deleteConversationRow(request.entityId, request.actorId)
    return
  }

  if (request.entityKind === 'project') {
    db.transaction((tx) => {
      tx.delete(projects)
        .where(and(eq(projects.actorId, request.actorId), eq(projects.id, request.entityId)))
        .run()
    })
  }
}

async function purgeCleanupTargets(request: LoadedDeletionRequest): Promise<void> {
  const targets = parseCleanupTargets(request.cleanupTargetsJson)
  if (!targets) return

  const dataDir = getAppContext().dataDir
  if (targets.kind === 'project') {
    for (const conversationId of targets.conversationIds ?? []) {
      await removeThreadAttachmentsDir(dataDir, conversationId)
    }
    return
  }

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
    if (
      request.threadId &&
      frozen.deleteOwningThread &&
      !isEntityDeletionBlocked('thread', request.threadId)
    ) {
      await drainAndDeleteThread(request.actorId, request.threadId)
    }

    const { getOrComposeExecution } = await import('../design-module')
    try {
      getOrComposeExecution(getAppContext()).scheduler.wake()
    } catch (error) {
      console.warn(
        '[deletion] wake execution queue after job delete failed',
        request.entityId,
        error
      )
    }
    return
  }

  if (request.entityKind === 'thread' && request.projectId) {
    const { touchProject } = await import('../projects/service')
    await touchProject(request.actorId, request.projectId)
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

      if (request.entityKind === 'project') {
        const frozenProject = frozen
        if (request.projectId) {
          await ensureProjectOwnedAggregatesDeleted({
            actorId: request.actorId,
            projectId: request.projectId,
            childConversationIds: frozenProject.childConversationIds,
            childDraftIds: frozenProject.childDraftIds,
            childPlanningSessionIds: frozenProject.childPlanningSessionIds
          })
        }
        if (frozen.childThreadIds?.length) {
          await ensureChildThreadsDeleted(request.actorId, frozen.childThreadIds)
        }
        if (request.projectId) {
          await ensureProjectExecutionJobsDeleted(
            request.actorId,
            request.projectId,
            frozen.childExecutionJobIds
          )
        }
      }

      if (request.entityKind === 'thread' && frozen.childJobIds?.length) {
        await ensureChildJobsDeleted(request.actorId, frozen.childJobIds)
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

export async function drainAndDeleteJob(actorId: string, jobId: string): Promise<void> {
  const active = findActiveDeletionRequest('thread_job', jobId)
  if (active) {
    return executeDeletionRequest(active.id)
  }

  const execution = readExecutionJobRow(jobId, actorId)
  if (!execution) {
    throw AppError.notFound('Job not found', 'job.not_found')
  }

  const projectId = execution.projectId
  const threadId = listProjectConversationIds(projectId)[0] ?? null
  const workspacePath = execution.workspaceRoot
  const frozen = await freezeJobRuntimeIdentity(jobId)
  const ownedAttachmentIds = collectJobOwnedAttachmentIds(execution.referenceManifestJson)

  const requestId = await createDeletionRequest({
    entityKind: 'thread_job',
    entityId: jobId,
    actorId,
    threadId,
    projectId,
    workspacePath,
    frozenJson: JSON.stringify({
      runtime: frozen,
      deleteOwningThread: false
    }),
    cleanupTargetsJson: JSON.stringify({
      kind: 'job',
      threadId: threadId ?? '',
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

export async function drainAndDeleteThread(actorId: string, threadId: string): Promise<void> {
  const active = findActiveDeletionRequest('thread', threadId)
  if (active) {
    return executeDeletionRequest(active.id)
  }

  const existing = getOwnedConversation(threadId, actorId)
  if (!existing) {
    throw AppError.notFound('Thread not found', 'thread.not_found')
  }

  const db = getDb()
  const purgeTargets = await collectThreadPurgeTargets(db, threadId)

  const requestId = await createDeletionRequest({
    entityKind: 'thread',
    entityId: threadId,
    actorId,
    threadId,
    projectId: existing.projectId,
    frozenJson: JSON.stringify({
      childJobIds: []
    } satisfies DeletionFrozenSnapshot),
    cleanupTargetsJson: JSON.stringify({
      kind: 'thread',
      threadId,
      targets: purgeTargets
    } satisfies CleanupTargets)
  })

  await executeDeletionRequest(requestId)
}

export async function drainAndDeleteProject(actorId: string, projectId: string): Promise<void> {
  const active = findActiveDeletionRequest('project', projectId)
  if (active) {
    return executeDeletionRequest(active.id)
  }

  const projectRows = await getDb()
    .select()
    .from(projects)
    .where(and(eq(projects.actorId, actorId), eq(projects.id, projectId)))
    .limit(1)
  const existing = projectRows[0]
  if (!existing) {
    throw AppError.notFound('Project not found', 'project.not_found')
  }

  const threadRows = listProjectConversationIds(projectId).map((id) => ({ id }))

  const client = sqliteClient()
  const executionJobIds = client
    ? (
        client
          .prepare(`SELECT id FROM jobs WHERE project_id = ? AND actor_id = ?`)
          .all(projectId, actorId) as Array<{ id: string }>
      ).map((row) => row.id)
    : []

  const childConversationIds = listProjectConversationIds(projectId)
  const childDraftIds = listProjectDraftIds(projectId, actorId)
  const childPlanningSessionIds = listProjectPlanningSessionIds(projectId, actorId)

  const requestId = await createDeletionRequest({
    entityKind: 'project',
    entityId: projectId,
    actorId,
    projectId,
    frozenJson: JSON.stringify({
      childThreadIds: threadRows.map((row) => row.id),
      childExecutionJobIds: executionJobIds,
      childConversationIds,
      childDraftIds,
      childPlanningSessionIds
    } satisfies DeletionFrozenSnapshot),
    cleanupTargetsJson: JSON.stringify({
      kind: 'project',
      conversationIds: childConversationIds
    } satisfies CleanupTargets)
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
