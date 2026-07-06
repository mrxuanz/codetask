import { randomUUID } from 'crypto'
import { hydrateTurnErrorField, coercePersistedTurnError } from '../turn-errors/store'
import { createTurnError } from '../../shared/turn-errors.ts'
import type { TurnErrorDto } from '../../shared/turn-errors.ts'
import { and, desc, eq } from 'drizzle-orm'
import { AppError } from '../error'
import { getDb } from '../db'
import { collectThreadPurgeTargets, purgeThreadFilesystem } from '../retention/purge'
import { getAppContext } from '../bootstrap'
import { threads, threadMessages, type Thread } from '../db/schema'
import { getProject, touchProject } from '../projects/service'
import { normalizeCoreCode } from '../conversation/cores'
import {
  DEFAULT_CORE_CODE,
  DEFAULT_THREAD_TITLE,
  RUNTIME_STATUS_ERROR,
  RUNTIME_STATUS_IDLE,
  RUNTIME_STATUS_RUNNING,
  THREAD_STATUS_DRAFT,
  TITLE_SOURCE_AUTO,
  TITLE_SOURCE_MANUAL,
  THREAD_KIND_CHAT,
  THREAD_KIND_CREATE_TASK,
  type ThreadDto,
  type ThreadKind,
  type TitleSource
} from './types'
import {
  getCorePhaseRuntime,
  parseCoreRuntimeJson,
  setCorePhaseRuntime,
  type CoreRuntimeMap
} from '../wizard/core-runtime'
import { resolveWizardPhase } from '../wizard/phase'
import {
  WIZARD_PHASE_DRAFT_REVIEW,
  WIZARD_PHASE_PLAN_EDIT,
  type WizardPhase
} from '../wizard/types'

function nowSec(): number {
  return Math.floor(Date.now() / 1000)
}

function defaultConversationId(now: number, id: string): string {
  return `conv-${now}-${id}`
}

function parseCoreRuntime(json: string): CoreRuntimeMap {
  return parseCoreRuntimeJson(json)
}

export function resolveThreadKind(row: Pick<Thread, 'threadKind'>): ThreadKind {
  return row.threadKind === THREAD_KIND_CREATE_TASK ? THREAD_KIND_CREATE_TASK : THREAD_KIND_CHAT
}

export function toThreadDto(row: Thread): ThreadDto {
  return {
    id: row.id,
    projectId: row.projectId,
    username: row.username,
    title: row.title,
    titleSource: (row.titleSource === TITLE_SOURCE_MANUAL
      ? TITLE_SOURCE_MANUAL
      : TITLE_SOURCE_AUTO) as TitleSource,
    activeDraftId: row.activeDraftId ?? null,
    activePlanId: row.activePlanId ?? null,
    wizardPhase: resolveWizardPhase(row),
    threadKind: resolveThreadKind(row),
    status: row.status,
    conversationId: row.conversationId,
    coreCode: row.coreCode,
    runtimeStatus: row.runtimeStatus,
    runtimeSessionId: row.runtimeSessionId,
    lastError: hydrateTurnErrorField(row.lastError),
    lastUsedAt: row.lastUsedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  }
}

function getCoreRuntime(row: Thread, coreCode: string, wizardPhase?: WizardPhase): string | null {
  const map = parseCoreRuntime(row.coreRuntimeJson)
  const phase = wizardPhase ?? resolveWizardPhase(row)
  return getCorePhaseRuntime(map, coreCode, phase)
}

async function saveCoreRuntime(
  threadId: string,
  row: Thread,
  coreCode: string,
  runtimeSessionId: string | null,
  wizardPhase?: WizardPhase
): Promise<void> {
  const map = parseCoreRuntime(row.coreRuntimeJson)
  const phase = wizardPhase ?? resolveWizardPhase(row)
  const next = setCorePhaseRuntime(map, coreCode, phase, runtimeSessionId)
  const db = getDb()
  await db
    .update(threads)
    .set({ coreRuntimeJson: JSON.stringify(next) })
    .where(eq(threads.id, threadId))
}

export async function listThreadsForUser(username: string): Promise<ThreadDto[]> {
  const db = getDb()
  const rows = await db
    .select()
    .from(threads)
    .where(eq(threads.username, username))
    .orderBy(desc(threads.updatedAt), desc(threads.createdAt))

  return rows.map(toThreadDto)
}

export async function listThreadsForProject(
  username: string,
  projectId: string
): Promise<ThreadDto[]> {
  const db = getDb()
  const rows = await db
    .select()
    .from(threads)
    .where(and(eq(threads.username, username), eq(threads.projectId, projectId)))
    .orderBy(desc(threads.updatedAt), desc(threads.createdAt))

  return rows.map(toThreadDto)
}

export async function getThreadRow(username: string, threadId: string): Promise<Thread | null> {
  const db = getDb()
  const rows = await db
    .select()
    .from(threads)
    .where(and(eq(threads.username, username), eq(threads.id, threadId)))
    .limit(1)

  return rows[0] ?? null
}

export async function getThread(username: string, threadId: string): Promise<ThreadDto | null> {
  const row = await getThreadRow(username, threadId)
  return row ? toThreadDto(row) : null
}

function resolveInitialCoreCode(coreCode?: string): string {
  if (!coreCode?.trim()) {
    return DEFAULT_CORE_CODE
  }
  try {
    return normalizeCoreCode(coreCode)
  } catch {
    return DEFAULT_CORE_CODE
  }
}

export async function createThread(
  username: string,
  projectId: string,
  title?: string,
  coreCode?: string,
  threadKind: ThreadKind = THREAD_KIND_CHAT
): Promise<ThreadDto> {
  const project = await getProject(username, projectId)
  if (!project) {
    throw AppError.notFound('Project not found', 'project.not_found')
  }

  const resolvedTitle = title?.trim() || DEFAULT_THREAD_TITLE
  const id = randomUUID()
  const now = nowSec()
  const conversationId = defaultConversationId(now, id)
  const db = getDb()

  await db.insert(threads).values({
    id,
    username,
    projectId,
    title: resolvedTitle,
    status: THREAD_STATUS_DRAFT,
    conversationId,
    coreCode: resolveInitialCoreCode(coreCode),
    runtimeStatus: RUNTIME_STATUS_IDLE,
    runtimeSessionId: null,
    coreRuntimeJson: '{}',
    lastError: null,
    lastUsedAt: null,
    titleSource: TITLE_SOURCE_AUTO,
    activeDraftId: null,
    activePlanId: null,
    wizardPhase: 'collect',
    threadKind,
    createdAt: now,
    updatedAt: now
  })

  await touchProject(username, projectId)

  const row = await getThreadRow(username, id)
  if (!row) {
    throw AppError.internal('Failed to read thread after creation', 'thread.read_failed')
  }
  return toThreadDto(row)
}

export async function renameThread(
  username: string,
  threadId: string,
  title: string,
  options?: { titleSource?: TitleSource }
): Promise<ThreadDto> {
  const trimmed = title.trim()
  if (!trimmed) {
    throw AppError.badRequest('Title cannot be empty', 'thread.title_empty')
  }

  const existing = await getThreadRow(username, threadId)
  if (!existing) {
    throw AppError.notFound('Thread not found', 'thread.not_found')
  }
  if (existing.title === trimmed && !options?.titleSource) {
    return toThreadDto(existing)
  }

  const now = nowSec()
  const db = getDb()
  const patch: Partial<Thread> = { title: trimmed, updatedAt: now }
  if (options?.titleSource) {
    patch.titleSource = options.titleSource
  } else {
    patch.titleSource = TITLE_SOURCE_MANUAL
  }
  await db
    .update(threads)
    .set(patch)
    .where(and(eq(threads.username, username), eq(threads.id, threadId)))

  await touchProject(username, existing.projectId)

  const row = await getThreadRow(username, threadId)
  if (!row) {
    throw AppError.internal('Failed to read thread after rename', 'thread.read_failed')
  }
  return toThreadDto(row)
}

export async function autoRenameThreadFromDraft(
  username: string,
  threadId: string,
  draftTitle: string
): Promise<ThreadDto | null> {
  const row = await getThreadRow(username, threadId)
  if (!row || row.titleSource === TITLE_SOURCE_MANUAL) return null
  const trimmed = draftTitle.trim()
  if (!trimmed || row.title === trimmed) return null
  return renameThread(username, threadId, trimmed, { titleSource: TITLE_SOURCE_AUTO })
}

export async function updateThreadContext(
  username: string,
  threadId: string,
  patch: { activeDraftId?: string | null; activePlanId?: string | null }
): Promise<ThreadDto> {
  const existing = await getThreadRow(username, threadId)
  if (!existing) throw AppError.notFound('Thread not found', 'thread.not_found')

  const now = nowSec()
  const db = getDb()
  const update: Partial<Thread> = { updatedAt: now }
  if (patch.activeDraftId !== undefined) update.activeDraftId = patch.activeDraftId
  if (patch.activePlanId !== undefined) update.activePlanId = patch.activePlanId
  if (patch.activePlanId) {
    update.wizardPhase = WIZARD_PHASE_PLAN_EDIT
  } else if (patch.activeDraftId && !existing.activePlanId) {
    update.wizardPhase = WIZARD_PHASE_DRAFT_REVIEW
  }

  await db
    .update(threads)
    .set(update)
    .where(and(eq(threads.username, username), eq(threads.id, threadId)))

  const row = await getThreadRow(username, threadId)
  if (!row)
    throw AppError.internal('Failed to read thread after updating context', 'thread.read_failed')
  return toThreadDto(row)
}

export async function updateThreadCore(
  username: string,
  threadId: string,
  coreCodeInput: string
): Promise<ThreadDto> {
  let normalized: string
  try {
    normalized = normalizeCoreCode(coreCodeInput)
  } catch (error) {
    throw AppError.badRequest(
      error instanceof Error ? error.message : 'Unsupported CLI',
      'provider.cli_auth_failed'
    )
  }

  const existing = await getThreadRow(username, threadId)
  if (!existing) {
    throw AppError.notFound('Thread not found', 'thread.not_found')
  }
  if (existing.coreCode === normalized) {
    return toThreadDto(existing)
  }
  if (existing.runtimeStatus === RUNTIME_STATUS_RUNNING) {
    throw AppError.badRequest('Thread is running; switch CLI after it finishes', 'thread.busy')
  }

  await saveCoreRuntime(threadId, existing, existing.coreCode, existing.runtimeSessionId)

  const restoredRuntime = getCoreRuntime(existing, normalized, resolveWizardPhase(existing))
  const now = nowSec()
  const db = getDb()
  await db
    .update(threads)
    .set({
      coreCode: normalized,
      runtimeStatus: RUNTIME_STATUS_IDLE,
      runtimeSessionId: restoredRuntime,
      lastError: null,
      updatedAt: now
    })
    .where(and(eq(threads.username, username), eq(threads.id, threadId)))

  await touchProject(username, existing.projectId)

  const row = await getThreadRow(username, threadId)
  if (!row) {
    throw AppError.internal('Failed to read thread after switching CLI', 'thread.read_failed')
  }
  return toThreadDto(row)
}

export async function updateThreadRuntime(
  username: string,
  threadId: string,
  coreCode: string,
  runtimeSessionId: string | null,
  runtimeStatus: string,
  lastError: TurnErrorDto | string | null
): Promise<ThreadDto> {
  const now = nowSec()
  const db = getDb()
  await db
    .update(threads)
    .set({
      runtimeStatus,
      runtimeSessionId,
      lastError: coercePersistedTurnError(lastError),
      lastUsedAt: now,
      updatedAt: now
    })
    .where(and(eq(threads.username, username), eq(threads.id, threadId)))

  const row = await getThreadRow(username, threadId)
  if (!row) {
    throw AppError.notFound('Thread not found', 'thread.not_found')
  }

  await saveCoreRuntime(threadId, row, coreCode, runtimeSessionId, resolveWizardPhase(row))

  const updated = await getThreadRow(username, threadId)
  if (!updated) {
    throw AppError.internal(
      'Failed to read thread after updating runtime status',
      'thread.read_failed'
    )
  }
  return toThreadDto(updated)
}

export async function threadHasMessages(threadId: string): Promise<boolean> {
  const db = getDb()
  const rows = await db
    .select({ id: threadMessages.id })
    .from(threadMessages)
    .where(eq(threadMessages.threadId, threadId))
    .limit(1)
  return rows.length > 0
}

export async function discardEmptyCreateTaskThreadIfUnused(
  username: string,
  threadId: string
): Promise<boolean> {
  const existing = await getThreadRow(username, threadId)
  if (!existing) return false
  if (resolveThreadKind(existing) !== THREAD_KIND_CREATE_TASK) return false
  const registry = getAppContext().runtimeRegistry
  if (registry.isThreadInflight(threadId)) return false
  if (await threadHasMessages(threadId)) return false
  await deleteThread(username, threadId)
  return true
}

export async function pruneEmptyCreateTaskThreads(): Promise<{ removed: number }> {
  const db = getDb()
  const registry = getAppContext().runtimeRegistry
  const rows = await db
    .select({ id: threads.id, username: threads.username })
    .from(threads)
    .where(eq(threads.threadKind, THREAD_KIND_CREATE_TASK))

  let removed = 0
  for (const row of rows) {
    if (registry.isThreadInflight(row.id)) continue
    if (await threadHasMessages(row.id)) continue
    try {
      await deleteThread(row.username, row.id)
      removed += 1
    } catch (error) {
      console.warn('[threads] failed to prune empty create_task thread', row.id, error)
    }
  }
  return { removed }
}

export async function deleteThread(username: string, threadId: string): Promise<void> {
  const existing = await getThreadRow(username, threadId)
  if (!existing) {
    throw AppError.notFound('Thread not found', 'thread.not_found')
  }

  const db = getDb()
  const purgeTargets = await collectThreadPurgeTargets(db, threadId)

  db.transaction((tx) => {
    tx.delete(threads)
      .where(and(eq(threads.username, username), eq(threads.id, threadId)))
      .run()
  })

  const dataDir = getAppContext().dataDir
  await purgeThreadFilesystem(dataDir, threadId, purgeTargets).catch((error) => {
    console.warn('[threads] failed to purge thread filesystem state', threadId, error)
  })

  await import('../agent-runtime/cursor-acp/stream-session-turn')
    .then((module) => module.closeConversationCursorRuntime(threadId))
    .catch((error) => {
      console.warn('[threads] failed to close cursor runtime for thread', threadId, error)
    })

  await touchProject(username, existing.projectId)
}

export async function reconcileStaleThreadRuntime(
  username: string,
  thread: ThreadDto,
  isInflight: (threadId: string) => boolean
): Promise<ThreadDto> {
  if (thread.runtimeStatus === RUNTIME_STATUS_RUNNING && !isInflight(thread.id)) {
    return updateThreadRuntime(
      username,
      thread.id,
      thread.coreCode,
      thread.runtimeSessionId,
      RUNTIME_STATUS_ERROR,
      createTurnError('thread.runtime_interrupted').toDto()
    )
  }
  return thread
}

export async function reconcileOrphanRunningThreadsOnStartup(
  isInflight: (threadId: string) => boolean
): Promise<void> {
  const db = getDb()
  const rows = await db
    .select()
    .from(threads)
    .where(eq(threads.runtimeStatus, RUNTIME_STATUS_RUNNING))

  for (const row of rows) {
    const dto = toThreadDto(row)
    try {
      await reconcileStaleThreadRuntime(row.username, dto, isInflight)
    } catch (error) {
      console.warn('[threads] failed to reconcile orphan running thread', row.id, error)
    }
  }
}
