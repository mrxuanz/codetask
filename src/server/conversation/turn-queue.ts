import { randomUUID } from 'crypto'
import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import { turnTopic } from '@shared/contracts/job-event-hub'
import type {
  ConversationTurnDto,
  ConversationTurnKind,
  ConversationTurnStatus,
  CreateTurnAcceptedDto
} from '@shared/contracts/conversation-turns'
import type { TurnHubEvent } from '@shared/contracts/conversation-turns'
import { conversationWorkspaceAccess } from '../../shared/workspace-access.ts'
import { getAppContext } from '../bootstrap'
import { getDb } from '../db'
import { conversationTurns } from '../db/schema'
import { AppError } from '../error'
import { toTurnErrorDto } from '../agent-runtime/errors'
import { hydrateTurnErrorField, persistTurnErrorDto } from '../turn-errors/store'
import { getThread } from '../threads/service'
import { resolveThreadAttachments } from './attachments'
import { streamSendMessage } from './service'

function nowSec(): number {
  return Math.floor(Date.now() / 1000)
}

function mapRow(row: typeof conversationTurns.$inferSelect): ConversationTurnDto {
  return {
    id: row.id,
    threadId: row.threadId,
    username: row.username,
    kind: row.kind as ConversationTurnKind,
    status: row.status as ConversationTurnStatus,
    workspaceAccess: row.workspaceAccess,
    provider: row.provider,
    messagePreview: row.messageText.slice(0, 120),
    queuePosition: null,
    stateRevision: row.stateRevision,
    lastError: hydrateTurnErrorField(row.lastErrorJson),
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    completedAt: row.completedAt
  }
}

function emitTurn(topicTurnId: string, event: TurnHubEvent): void {
  getAppContext().eventBus.emit(turnTopic(topicTurnId), event)
}

export async function getTurn(username: string, turnId: string): Promise<ConversationTurnDto | null> {
  const row = getDb()
    .select()
    .from(conversationTurns)
    .where(and(eq(conversationTurns.id, turnId), eq(conversationTurns.username, username)))
    .limit(1)
    .all()[0]
  return row ? mapRow(row) : null
}

function countQueuedAhead(threadId: string, createdAt: number): number {
  const row = getDb()
    .select({ count: sql<number>`count(*)` })
    .from(conversationTurns)
    .where(
      and(
        eq(conversationTurns.threadId, threadId),
        eq(conversationTurns.status, 'queued'),
        sql`${conversationTurns.createdAt} < ${createdAt}`
      )
    )
    .get()
  return row?.count ?? 0
}

export interface EnqueueTurnInput {
  username: string
  threadId: string
  message: string
  generateDraft?: boolean
  createTaskMode?: boolean
  attachmentIds?: string[]
  selectedDraftSection?: string
  selectedPlanNodeRef?: string
  idempotencyKey?: string | null
  provider?: string | null
  kind?: ConversationTurnKind
}

/**
 * Accept a turn asynchronously. Same-thread turns serialize via queued status;
 * over-capacity users also queue instead of receiving 429.
 */
export async function enqueueConversationTurn(input: EnqueueTurnInput): Promise<CreateTurnAcceptedDto> {
  const message = input.message.trim()
  if (!message && !(input.attachmentIds?.length ?? 0)) {
    throw AppError.badRequest('Message cannot be empty', 'message.empty')
  }

  const thread = await getThread(input.username, input.threadId)
  if (!thread) {
    throw AppError.notFound('Thread not found', 'thread.not_found', { threadId: input.threadId })
  }

  if (input.idempotencyKey) {
    const existing = getDb()
      .select()
      .from(conversationTurns)
      .where(
        and(
          eq(conversationTurns.username, input.username),
          eq(conversationTurns.idempotencyKey, input.idempotencyKey)
        )
      )
      .limit(1)
      .all()[0]
    if (existing) {
      const dto = mapRow(existing)
      return {
        turnId: dto.id,
        status: dto.status,
        revision: dto.stateRevision,
        queuePosition:
          dto.status === 'queued' ? countQueuedAhead(dto.threadId, dto.createdAt) + 1 : null
      }
    }
  }

  const now = nowSec()
  const turnId = `turn-${randomUUID()}`
  const kind: ConversationTurnKind =
    input.kind ?? (input.createTaskMode || input.generateDraft ? 'create_task' : 'chat')

  getDb()
    .insert(conversationTurns)
    .values({
      id: turnId,
      threadId: input.threadId,
      username: input.username,
      kind,
      status: 'queued',
      workspaceAccess: conversationWorkspaceAccess(true),
      provider: input.provider ?? null,
      messageText: message,
      generateDraft: input.generateDraft === true ? 1 : 0,
      createTaskMode: input.createTaskMode === true ? 1 : 0,
      attachmentIdsJson: JSON.stringify(input.attachmentIds ?? []),
      selectedDraftSection: input.selectedDraftSection ?? null,
      selectedPlanNodeRef: input.selectedPlanNodeRef ?? null,
      idempotencyKey: input.idempotencyKey ?? null,
      stateRevision: 1,
      lastErrorJson: null,
      createdAt: now,
      startedAt: null,
      completedAt: null
    })
    .run()

  const queuePosition = countQueuedAhead(input.threadId, now) + 1
  const turn = await getTurn(input.username, turnId)
  if (turn) {
    emitTurn(turnId, { event: 'turn_snapshot', data: { turn: { ...turn, queuePosition } } })
  }

  void advanceTurnQueue(input.username).catch((error) => {
    console.warn('[turn-queue] advance failed', error)
  })

  return {
    turnId,
    status: 'queued',
    revision: 1,
    queuePosition
  }
}

export async function cancelConversationTurn(
  username: string,
  turnId: string
): Promise<ConversationTurnDto> {
  const row = getDb()
    .select()
    .from(conversationTurns)
    .where(and(eq(conversationTurns.id, turnId), eq(conversationTurns.username, username)))
    .limit(1)
    .all()[0]
  if (!row) throw AppError.notFound('Turn not found', 'turn.not_found')

  if (row.status === 'completed' || row.status === 'failed' || row.status === 'cancelled') {
    return mapRow(row)
  }

  if (row.status === 'queued') {
    getDb()
      .update(conversationTurns)
      .set({
        status: 'cancelled',
        completedAt: nowSec(),
        stateRevision: row.stateRevision + 1
      })
      .where(eq(conversationTurns.id, turnId))
      .run()
  } else {
    getDb()
      .update(conversationTurns)
      .set({ status: 'cancelling', stateRevision: row.stateRevision + 1 })
      .where(eq(conversationTurns.id, turnId))
      .run()
  }

  const updated = (await getTurn(username, turnId))!
  emitTurn(turnId, { event: 'turn_snapshot', data: { turn: updated } })
  void advanceTurnQueue(username).catch(() => {})
  return updated
}

function countActiveTurnsForUser(username: string): number {
  const row = getDb()
    .select({ count: sql<number>`count(*)` })
    .from(conversationTurns)
    .where(
      and(
        eq(conversationTurns.username, username),
        inArray(conversationTurns.status, ['admitted', 'running', 'committing', 'cancelling'])
      )
    )
    .get()
  return row?.count ?? 0
}

function threadHasActiveTurn(threadId: string): boolean {
  const row = getDb()
    .select({ id: conversationTurns.id })
    .from(conversationTurns)
    .where(
      and(
        eq(conversationTurns.threadId, threadId),
        inArray(conversationTurns.status, ['admitted', 'running', 'committing', 'cancelling'])
      )
    )
    .limit(1)
    .all()[0]
  return Boolean(row)
}

export async function advanceTurnQueue(username?: string): Promise<void> {
  const ctx = getAppContext()
  const maxActive = ctx.config.http.maxConcurrentTurnsPerUser
  const db = getDb()

  const queued = db
    .select()
    .from(conversationTurns)
    .where(
      and(
        eq(conversationTurns.status, 'queued'),
        username ? eq(conversationTurns.username, username) : sql`1 = 1`
      )
    )
    .orderBy(asc(conversationTurns.createdAt))
    .all()

  for (const row of queued) {
    if (threadHasActiveTurn(row.threadId)) continue
    if (countActiveTurnsForUser(row.username) >= maxActive) continue

    const cas = db
      .update(conversationTurns)
      .set({
        status: 'admitted',
        startedAt: nowSec(),
        stateRevision: row.stateRevision + 1
      })
      .where(and(eq(conversationTurns.id, row.id), eq(conversationTurns.status, 'queued')))
      .run()
    if ((cas.changes ?? 0) !== 1) continue

    const admitted = mapRow({
      ...row,
      status: 'admitted',
      startedAt: nowSec(),
      stateRevision: row.stateRevision + 1
    })
    emitTurn(row.id, { event: 'turn_snapshot', data: { turn: admitted } })
    void runAdmittedTurn(row.id).catch((error) => {
      console.warn('[turn-queue] run failed', row.id, error)
    })
  }
}

async function runAdmittedTurn(turnId: string): Promise<void> {
  const db = getDb()
  const row = db.select().from(conversationTurns).where(eq(conversationTurns.id, turnId)).limit(1).all()[0]
  if (!row || row.status !== 'admitted') return

  db.update(conversationTurns)
    .set({ status: 'running', stateRevision: row.stateRevision + 1 })
    .where(eq(conversationTurns.id, turnId))
    .run()

  emitTurn(turnId, {
    event: 'turn_snapshot',
    data: { turn: mapRow({ ...row, status: 'running', stateRevision: row.stateRevision + 1 }) }
  })

  const attachmentIds = JSON.parse(row.attachmentIdsJson || '[]') as string[]
  const attachments = resolveThreadAttachments(row.threadId, attachmentIds)

  try {
    for await (const chunk of streamSendMessage(row.username, row.threadId, row.messageText, {
      generateDraft: row.generateDraft === 1,
      createTaskMode: row.createTaskMode === 1,
      attachments,
      selectedDraftSection: row.selectedDraftSection ?? undefined,
      selectedPlanNodeRef: row.selectedPlanNodeRef ?? undefined
    })) {
      const latest = db
        .select({ status: conversationTurns.status })
        .from(conversationTurns)
        .where(eq(conversationTurns.id, turnId))
        .limit(1)
        .all()[0]
      if (latest?.status === 'cancelling') {
        emitTurn(turnId, { event: 'error', data: { message: 'Turn cancelled' } })
        db.update(conversationTurns)
          .set({
            status: 'cancelled',
            completedAt: nowSec(),
            stateRevision: sql`${conversationTurns.stateRevision} + 1`
          })
          .where(eq(conversationTurns.id, turnId))
          .run()
        return
      }
      emitTurn(turnId, chunk)
    }

    db.update(conversationTurns)
      .set({
        status: 'completed',
        completedAt: nowSec(),
        stateRevision: sql`${conversationTurns.stateRevision} + 1`
      })
      .where(eq(conversationTurns.id, turnId))
      .run()
  } catch (error) {
    const turnError = toTurnErrorDto(error)
    const errorJson = persistTurnErrorDto(turnError)
    db.update(conversationTurns)
      .set({
        status: 'failed',
        completedAt: nowSec(),
        lastErrorJson: errorJson,
        stateRevision: sql`${conversationTurns.stateRevision} + 1`
      })
      .where(eq(conversationTurns.id, turnId))
      .run()
    emitTurn(turnId, {
      event: 'error',
      data: { error: turnError, message: turnError.message }
    })
  } finally {
    const finalRow = db
      .select()
      .from(conversationTurns)
      .where(eq(conversationTurns.id, turnId))
      .limit(1)
      .all()[0]
    if (finalRow) {
      emitTurn(turnId, { event: 'turn_snapshot', data: { turn: mapRow(finalRow) } })
    }
    void advanceTurnQueue(row.username).catch(() => {})
  }
}
