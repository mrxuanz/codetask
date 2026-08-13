import {
  buildConversationScopeId,
  contextPolicyFor,
  type AgentRuntime,
  type ProviderCode as RuntimeProviderCode
} from '@codetask/agent-runtime'
import type {
  ConversationDto,
  ConversationMessageDto,
  ConversationTurnDto,
  CreateTurnAcceptedDto,
  ProviderCode,
  ProviderSummary
} from '@codetask/contracts'
import {
  conversationTopic,
  conversationTurnTopic,
  MAX_CONVERSATION_TITLE_CHARS
} from '@codetask/contracts'
import {
  toConversationDto,
  toMessageDto,
  toTurnDto,
  type ConversationRecord,
  type TurnRecord
} from '../domain/conversation.ts'
import type { ConversationModulePorts } from '../ports/ports.ts'
import {
  ConversationConflictError,
  ConversationForbiddenError,
  ConversationNotFoundError,
  ConversationValidationError,
  newId,
  nowIso,
  stableHash,
  type Actor
} from '../shared.ts'

const DEFAULT_TITLE = 'New thread'
const MAX_HISTORY_MESSAGES = 30
const MAX_HISTORY_CHARS = 32_000
const MAX_ASSISTANT_REPLY_CHARS = 512 * 1024
const MAX_ASSISTANT_THINKING_CHARS = 128 * 1024
const MAX_CONVERSATION_TURN_MS = 30 * 60 * 1000
const MAX_QUEUED_TURNS_PER_ACTOR = 100
const MAX_QUEUED_PAYLOAD_BYTES_PER_ACTOR = 16 * 1024 * 1024
const QUEUE_SCAN_LIMIT = 128
const MAX_REALTIME_ERROR_CHARS = 2_048
const OUTPUT_TRUNCATED_NOTICE = '\n\n[Output truncated: conversation response limit reached.]'

function truncateOutput(value: string, limit: number): string {
  if (value.length <= limit) return value
  const keep = Math.max(0, limit - OUTPUT_TRUNCATED_NOTICE.length)
  return `${value.slice(0, keep)}${OUTPUT_TRUNCATED_NOTICE}`
}

function buildBoundedHistory(
  messages: Array<{ role: string; content: string; providerCode: string | null }>
): string {
  const lines = messages
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .map((message) => {
      const provider = message.providerCode ? ` (${message.providerCode})` : ''
      return `${message.role}${provider}: ${message.content.trim()}`
    })
    .filter((line) => !line.endsWith(': '))
  let history = lines.join('\n\n')
  if (history.length > MAX_HISTORY_CHARS) {
    history = `…(earlier messages truncated)\n\n${history.slice(-MAX_HISTORY_CHARS)}`
  }
  return history
}

function toRealtimeTurnDto(
  turn: TurnRecord,
  queuePosition: number | null = null
): ConversationTurnDto {
  const dto = toTurnDto(turn, queuePosition)
  const error = dto.lastError
    ? {
        code: dto.lastError.code.slice(0, 128),
        message: dto.lastError.message.slice(0, MAX_REALTIME_ERROR_CHARS),
        ...(dto.lastError.detail
          ? { detail: dto.lastError.detail.slice(0, MAX_REALTIME_ERROR_CHARS) }
          : {})
      }
    : null
  // Turn input is available from the REST snapshot and user message. Repeating a
  // 512 KiB prompt in every durable state event would exceed the event-log cap.
  return { ...dto, inputText: '', lastError: error }
}

export class ConversationApplication {
  private readonly abortControllers = new Map<string, AbortController>()
  private readonly activeTurnPromises = new Map<string, Promise<void>>()
  private readonly deletingConversationIds = new Set<string>()
  private readonly pendingAdvanceActors = new Set<string | null>()
  private advancing = false

  constructor(private readonly ports: ConversationModulePorts) {}

  listProviders(): Promise<ProviderSummary[]> {
    const runtime = this.ports.agentRuntime as AgentRuntime & {
      listProviders?: () => Promise<ProviderSummary[]>
    }
    return runtime.listProviders?.() ?? Promise.resolve([])
  }

  list(actor: Actor): ConversationDto[] {
    return this.ports.conversations.listForActor(actor.userId).map(toConversationDto)
  }

  listForProject(actor: Actor, projectId: string): ConversationDto[] {
    return this.ports.conversations.listForProject(actor.userId, projectId).map(toConversationDto)
  }

  get(actor: Actor, conversationId: string): ConversationDto {
    return toConversationDto(this.requireOwned(actor, conversationId))
  }

  /** Owner lookup for asset-token attachment reads (no actor session required). */
  ownerOf(conversationId: string): string | null {
    return this.ports.conversations.get(conversationId)?.actorId ?? null
  }

  create(
    actor: Actor,
    projectId: string,
    input: { title?: string; providerCode?: ProviderCode }
  ): ConversationDto {
    const now = nowIso()
    const title = input.title?.trim() ?? ''
    if (title.length > MAX_CONVERSATION_TITLE_CHARS) {
      throw new ConversationValidationError('Conversation title is too long')
    }
    const row: ConversationRecord = {
      id: newId('conv'),
      actorId: actor.userId,
      projectId,
      title: title || DEFAULT_TITLE,
      titleSource: title ? 'manual' : 'auto',
      providerCode: input.providerCode ?? this.ports.defaultProviderCode,
      state: 'active',
      stateRevision: 0,
      createdAt: now,
      updatedAt: now,
      lastUsedAt: null
    }
    this.ports.conversations.insert(row)
    const dto = toConversationDto(row)
    this.publishRealtime(conversationTopic(row.id), 'conversation.changed', {
      conversation: dto
    })
    return dto
  }

  rename(actor: Actor, conversationId: string, title: string): ConversationDto {
    const trimmed = title.trim()
    if (!trimmed) throw new ConversationValidationError('Title cannot be empty')
    if (trimmed.length > MAX_CONVERSATION_TITLE_CHARS) {
      throw new ConversationValidationError('Conversation title is too long')
    }
    const row = this.requireOwned(actor, conversationId)
    const next = {
      ...row,
      title: trimmed,
      titleSource: 'manual' as const,
      stateRevision: row.stateRevision + 1,
      updatedAt: nowIso()
    }
    this.ports.conversations.update(next)
    const dto = toConversationDto(next)
    this.publishRealtime(conversationTopic(row.id), 'conversation.changed', {
      conversation: dto
    })
    return dto
  }

  async switchProvider(
    actor: Actor,
    conversationId: string,
    providerCode: ProviderCode
  ): Promise<ConversationDto> {
    const row = this.requireOwned(actor, conversationId)
    if (this.ports.turns.hasActiveForConversation(conversationId)) {
      throw new ConversationConflictError('Cannot switch provider while a turn is active')
    }
    const oldScope = buildConversationScopeId(row.id, row.providerCode as RuntimeProviderCode)
    await this.ports.agentRuntime.closeScope(oldScope)
    const next = {
      ...row,
      providerCode,
      stateRevision: row.stateRevision + 1,
      updatedAt: nowIso()
    }
    this.ports.conversations.update(next)
    const dto = toConversationDto(next)
    this.publishRealtime(conversationTopic(row.id), 'conversation.changed', {
      conversation: dto
    })
    return dto
  }

  async delete(actor: Actor, conversationId: string): Promise<void> {
    const row = this.requireOwned(actor, conversationId)
    this.deletingConversationIds.add(conversationId)
    try {
      const activeTurns = this.ports.turns.listActiveForConversation(conversationId)
      for (const turn of activeTurns) {
        this.abortControllers.get(turn.id)?.abort('conversation.deleted')
      }
      await Promise.allSettled(
        activeTurns.map((turn) => this.ports.agentRuntime.abort(turn.id, 'conversation.deleted'))
      )
      await this.ports.agentRuntime.closeScope(
        buildConversationScopeId(row.id, row.providerCode as RuntimeProviderCode)
      )
      await Promise.allSettled(
        activeTurns
          .map((turn) => this.activeTurnPromises.get(turn.id))
          .filter((promise): promise is Promise<void> => promise !== undefined)
      )

      this.ports.turns.deleteForConversation(conversationId)
      this.ports.messages.deleteForConversation(conversationId)
      this.ports.conversations.delete(conversationId)
      this.ports.attachments?.releaseConversation?.(conversationId)
      this.publishRealtime(conversationTopic(conversationId), 'conversation.deleted', {
        conversationId
      })
    } finally {
      this.deletingConversationIds.delete(conversationId)
      void this.advanceQueue(actor.userId)
    }
  }

  listMessages(
    actor: Actor,
    conversationId: string,
    limit = 100,
    before?: { createdAt: string; id: string }
  ): ConversationMessageDto[] {
    this.requireOwned(actor, conversationId)
    return this.ports.messages.list(conversationId, limit, before).map(toMessageDto)
  }

  getTurn(actor: Actor, conversationId: string, turnId: string): ConversationTurnDto {
    this.requireOwned(actor, conversationId)
    const turn = this.ports.turns.get(turnId)
    if (!turn || turn.conversationId !== conversationId) {
      throw new ConversationNotFoundError('Turn not found')
    }
    const queuePosition =
      turn.state === 'queued'
        ? this.ports.turns.countQueuedAhead(conversationId, turn.createdAt, turn.id) + 1
        : null
    return toTurnDto(turn, queuePosition)
  }

  getActiveTurn(actor: Actor, conversationId: string): ConversationTurnDto | null {
    this.requireOwned(actor, conversationId)
    const turn = this.ports.turns.getActiveForConversation(conversationId)
    return turn ? toTurnDto(turn, null) : null
  }

  enqueueTurn(
    actor: Actor,
    conversationId: string,
    input: {
      message: string
      attachmentIds: string[]
      idempotencyKey: string
      providerCode?: ProviderCode
    }
  ): CreateTurnAcceptedDto {
    const conversation = this.requireOwned(actor, conversationId)
    const message = input.message.trim()
    if (!message && input.attachmentIds.length === 0) {
      throw new ConversationValidationError('Message cannot be empty')
    }
    if (!input.idempotencyKey.trim()) {
      throw new ConversationValidationError('idempotencyKey is required')
    }

    const existing = this.ports.turns.getByIdempotency(actor.userId, input.idempotencyKey)
    if (existing) {
      if (existing.conversationId !== conversationId) {
        throw new ConversationConflictError(
          'Idempotency key was already used for another conversation'
        )
      }
      const requestHash = stableHash(
        JSON.stringify({
          message,
          attachmentIds: input.attachmentIds,
          providerCode: input.providerCode ?? conversation.providerCode
        })
      )
      if (existing.requestHash && existing.requestHash !== requestHash) {
        throw new ConversationConflictError('Idempotency key conflict with different request')
      }
      const queuePosition =
        existing.state === 'queued'
          ? this.ports.turns.countQueuedAhead(conversationId, existing.createdAt, existing.id) + 1
          : null
      return {
        turnId: existing.id,
        status: existing.state,
        revision: existing.stateRevision,
        queuePosition
      }
    }

    const providerCode = input.providerCode ?? conversation.providerCode
    const requestHash = stableHash(
      JSON.stringify({ message, attachmentIds: input.attachmentIds, providerCode })
    )
    const now = nowIso()

    let settingsSnapshotJson = JSON.stringify({ attachmentIds: input.attachmentIds })
    let settingsHash = stableHash(JSON.stringify(input.attachmentIds))
    if (this.ports.captureSettingsForTurn) {
      const captured = this.ports.captureSettingsForTurn(providerCode)
      settingsSnapshotJson = JSON.stringify({
        attachmentIds: input.attachmentIds,
        conversation: {
          promptBody: captured.promptBody,
          mcpServers: captured.mcpServers,
          sourceRevisions: captured.sourceRevisions
        },
        settingsHash: captured.contentHash
      })
      settingsHash = captured.contentHash
    }

    const queued = this.ports.turns.queuedStats(actor.userId)
    const incomingBytes =
      Buffer.byteLength(message, 'utf8') + Buffer.byteLength(settingsSnapshotJson, 'utf8')
    if (
      queued.count >= MAX_QUEUED_TURNS_PER_ACTOR ||
      queued.payloadBytes + incomingBytes > MAX_QUEUED_PAYLOAD_BYTES_PER_ACTOR
    ) {
      throw new ConversationConflictError(
        'Conversation queue is full; wait for an earlier turn to finish or cancel it'
      )
    }

    const turn: TurnRecord = {
      id: newId('turn'),
      conversationId,
      actorId: actor.userId,
      state: 'queued',
      inputText: message,
      providerCode,
      workspaceAccess: 'live-read',
      settingsSnapshotJson,
      settingsHash,
      idempotencyKey: input.idempotencyKey,
      requestHash,
      stateRevision: 1,
      userMessageId: null,
      assistantMessageId: null,
      lastErrorJson: null,
      createdAt: now,
      admittedAt: null,
      startedAt: null,
      completedAt: null
    }
    this.ports.turns.insert(turn)
    const queuePosition = this.ports.turns.countQueuedAhead(conversationId, now, turn.id) + 1
    this.publishTurn(turn, queuePosition)
    void this.advanceQueue(actor.userId)
    return {
      turnId: turn.id,
      status: 'queued',
      revision: 1,
      queuePosition
    }
  }

  cancelTurn(actor: Actor, conversationId: string, turnId: string): ConversationTurnDto {
    this.requireOwned(actor, conversationId)
    const turn = this.ports.turns.get(turnId)
    if (!turn || turn.conversationId !== conversationId) {
      throw new ConversationNotFoundError('Turn not found')
    }
    if (turn.state === 'completed' || turn.state === 'failed' || turn.state === 'cancelled') {
      return toTurnDto(turn)
    }
    if (turn.state === 'queued') {
      const next = {
        ...turn,
        state: 'cancelled' as const,
        completedAt: nowIso(),
        stateRevision: turn.stateRevision + 1
      }
      this.ports.turns.update(next)
      this.publishTurn(next, null)
      void this.advanceQueue(actor.userId)
      this.publishRealtime(conversationTurnTopic(turnId), 'turn.cancelled', {
        turn: toRealtimeTurnDto(next)
      })
      return toTurnDto(next)
    }
    const next = { ...turn, state: 'cancelling' as const, stateRevision: turn.stateRevision + 1 }
    this.ports.turns.update(next)
    this.abortControllers.get(turnId)?.abort('turn.cancelled')
    void this.ports.agentRuntime.abort(turnId, 'turn.cancelled')
    this.publishTurn(next, null)
    return toTurnDto(next)
  }

  async advanceQueue(actorId?: string): Promise<void> {
    this.pendingAdvanceActors.add(actorId ?? null)
    if (this.advancing) return
    this.advancing = true
    try {
      while (this.pendingAdvanceActors.size > 0) {
        const pendingActor = this.pendingAdvanceActors.values().next().value as string | null
        this.pendingAdvanceActors.delete(pendingActor)
        const queued = this.ports.turns.listAdmittableQueued(
          pendingActor ?? undefined,
          QUEUE_SCAN_LIMIT,
          this.ports.maxConcurrentTurnsPerUser
        )
        let admittedCount = 0
        for (const row of queued) {
          if (this.deletingConversationIds.has(row.conversationId)) continue
          if (this.ports.turns.hasActiveForConversation(row.conversationId)) continue
          if (
            this.ports.turns.countActiveForActor(row.actorId) >=
            this.ports.maxConcurrentTurnsPerUser
          ) {
            continue
          }
          const admittedAt = nowIso()
          const admitted: TurnRecord = {
            ...row,
            state: 'admitted',
            admittedAt,
            startedAt: admittedAt,
            stateRevision: row.stateRevision + 1
          }
          const current = this.ports.turns.get(row.id)
          if (!current || current.state !== 'queued') continue
          this.ports.turns.update(admitted)
          admittedCount += 1
          this.publishTurn(admitted, null)
          const run = this.runAdmittedTurn(admitted.id).catch((error) => {
            console.error('[conversation] admitted turn crashed outside its error boundary', {
              turnId: admitted.id,
              error
            })
          })
          this.activeTurnPromises.set(admitted.id, run)
          void run.then(() => this.activeTurnPromises.delete(admitted.id))
        }
        if (pendingActor === null && queued.length === QUEUE_SCAN_LIMIT && admittedCount > 0) {
          this.pendingAdvanceActors.add(null)
        }
      }
    } finally {
      this.advancing = false
    }
  }

  reconcileOnStartup(): void {
    for (const turn of this.ports.turns.listActive()) {
      const failed: TurnRecord = {
        ...turn,
        state: 'failed',
        completedAt: nowIso(),
        lastErrorJson: JSON.stringify({
          code: 'runtime.interrupted',
          message: 'The application restarted before this turn completed'
        }),
        stateRevision: turn.stateRevision + 1
      }
      this.ports.turns.update(failed)
      this.publishTurn(failed, null)
      this.publishRealtime(conversationTurnTopic(turn.id), 'turn.failed', {
        turn: toRealtimeTurnDto(failed)
      })
    }
  }

  private async runAdmittedTurn(turnId: string): Promise<void> {
    const turn = this.ports.turns.get(turnId)
    if (!turn || turn.state !== 'admitted') return

    const conversation = this.ports.conversations.get(turn.conversationId)
    if (!conversation) {
      this.failTurn(turn, 'Conversation missing')
      return
    }

    let running: TurnRecord = {
      ...turn,
      state: 'running',
      stateRevision: turn.stateRevision + 1,
      startedAt: turn.startedAt ?? nowIso()
    }
    this.ports.turns.update(running)
    this.publishTurn(running, null)

    const controller = new AbortController()
    this.abortControllers.set(turnId, controller)
    let timedOut = false
    const turnTimeout = setTimeout(() => {
      timedOut = true
      controller.abort('conversation.turn_timeout')
      void this.ports.agentRuntime.abort(turnId, 'conversation.turn_timeout')
    }, MAX_CONVERSATION_TURN_MS)
    turnTimeout.unref?.()
    let leaseId: string | null = null
    let releaseSystemMcp: (() => void) | null = null

    try {
      const workspace = await this.ports.workspace.resolveWorkspaceRoot({
        actorId: turn.actorId,
        projectId: conversation.projectId
      })

      const exclusive = this.ports.leases.tryAcquireExclusive({
        workspaceRoot: workspace.workspaceRoot,
        ownerId: turnId
      })
      const workspaceAccess = !workspace.workspaceRoot.trim()
        ? ('metadata' as const)
        : exclusive
          ? ('exclusive-write' as const)
          : ('live-read' as const)
      const capabilityProfile = exclusive ? 'chat-write' : 'chat-read'
      if (exclusive) leaseId = exclusive.leaseId

      running = {
        ...running,
        workspaceAccess,
        stateRevision: running.stateRevision + 1
      }
      this.ports.turns.update(running)
      this.publishTurn(running, null)

      const userMessageId = newId('msg')
      const userCreatedAt = nowIso()

      let attachmentIds: string[] = []
      let conversationSnap: {
        promptBody?: string | null
        mcpServers?: Record<string, unknown>
      } | null = null
      try {
        const snap = JSON.parse(turn.settingsSnapshotJson) as {
          attachmentIds?: unknown
          conversation?: { promptBody?: string | null; mcpServers?: Record<string, unknown> }
        }
        if (Array.isArray(snap.attachmentIds)) {
          attachmentIds = snap.attachmentIds.filter((id): id is string => typeof id === 'string')
        }
        if (snap.conversation && typeof snap.conversation === 'object') {
          conversationSnap = snap.conversation
        }
      } catch {
        attachmentIds = []
      }

      const resolvedAttachments =
        attachmentIds.length > 0 && this.ports.attachments
          ? this.ports.attachments.resolveForTurn({
              conversationId: conversation.id,
              attachmentIds
            })
          : { attachments: [], readRoots: [] as string[], promptAppendix: '' }

      if (
        attachmentIds.length > 0 &&
        resolvedAttachments.attachments.length !== attachmentIds.length
      ) {
        throw new ConversationValidationError('One or more attachments were not found')
      }

      this.ports.transaction(() => {
        this.ports.messages.insert({
          id: userMessageId,
          conversationId: conversation.id,
          turnId,
          role: 'user',
          kind: 'text',
          content: turn.inputText,
          providerCode: turn.providerCode,
          model: null,
          thinkingText: null,
          thinkingDurationMs: null,
          createdAt: userCreatedAt,
          attachments: resolvedAttachments.attachments
        })
        if (resolvedAttachments.attachments.length > 0) {
          this.ports.messages.insertAttachments(
            resolvedAttachments.attachments.map((att) => ({
              ...att,
              messageId: userMessageId,
              conversationId: conversation.id,
              createdAt: userCreatedAt
            }))
          )
        }
      })
      this.publishRealtime(conversationTopic(conversation.id), 'message.committed', {
        message: toMessageDto({
          id: userMessageId,
          conversationId: conversation.id,
          turnId,
          role: 'user',
          kind: 'text',
          content: turn.inputText,
          providerCode: turn.providerCode,
          model: null,
          thinkingText: null,
          thinkingDurationMs: null,
          createdAt: userCreatedAt,
          attachments: resolvedAttachments.attachments
        })
      })

      // Auto title from first user text
      if (conversation.titleSource === 'auto' && conversation.title === DEFAULT_TITLE) {
        const title =
          turn.inputText.trim().slice(0, 48) ||
          (resolvedAttachments.attachments[0]?.name
            ? `Attachment: ${resolvedAttachments.attachments[0].name}`.slice(0, 48)
            : DEFAULT_TITLE)
        const updatedConv = {
          ...conversation,
          title,
          updatedAt: nowIso(),
          stateRevision: conversation.stateRevision + 1
        }
        this.ports.conversations.update(updatedConv)
        this.publishRealtime(conversationTopic(conversation.id), 'conversation.changed', {
          conversation: toConversationDto(updatedConv)
        })
      }

      const scopeId = buildConversationScopeId(
        conversation.id,
        turn.providerCode as RuntimeProviderCode
      )
      const history = this.ports.messages
        .list(conversation.id, MAX_HISTORY_MESSAGES)
        .filter((message) => message.id !== userMessageId)
      const policy = contextPolicyFor('conversation', capabilityProfile)
      const scope = policy.sessionReusable
        ? await this.ports.agentRuntime.inspectScope(scopeId)
        : null
      const canResumeProviderSession = Boolean(scope?.binding?.providerSessionId)
      const historyBlock =
        policy.requiresHistorySeed || !canResumeProviderSession ? buildBoundedHistory(history) : ''
      const basePrompt = historyBlock ? `${historyBlock}\nuser: ${turn.inputText}` : turn.inputText
      const prompt = resolvedAttachments.promptAppendix
        ? `${basePrompt}\n\n${resolvedAttachments.promptAppendix}`
        : basePrompt

      let reply = ''
      let thinking = ''
      let thinkingStarted = 0

      const systemPrompt =
        conversationSnap && 'promptBody' in conversationSnap
          ? (conversationSnap.promptBody?.trim() ?? '')
          : this.ports.resolveSystemPrompt()
      const userMcpServers = conversationSnap?.mcpServers ?? {}
      const systemMcp = this.ports.systemMcp?.bindForTurn({
        sessionId: turnId,
        conversationId: conversation.id,
        actorId: turn.actorId,
        providerCode: turn.providerCode,
        workspaceRoot: workspace.workspaceRoot,
        userMessageId,
        attachments: resolvedAttachments.attachments
      })
      releaseSystemMcp = systemMcp?.release ?? null

      for await (const event of this.ports.agentRuntime.runTurn({
        role: 'conversation',
        provider: turn.providerCode as RuntimeProviderCode,
        workspaceRoot: workspace.workspaceRoot || undefined,
        capabilityProfile,
        workspaceAccess,
        ...(exclusive
          ? {
              workspaceLease: {
                leaseId: exclusive.leaseId,
                ownerKind: 'conversation',
                ownerId: turnId
              }
            }
          : {}),
        prompt,
        systemPrompt,
        userMcpServers,
        ...(systemMcp && systemMcp.mcpServers.length > 0
          ? { mcpServers: systemMcp.mcpServers }
          : {}),
        scopeId,
        turnId,
        readRoots: resolvedAttachments.readRoots,
        signal: controller.signal
      })) {
        const latest = this.ports.turns.get(turnId)
        if (latest?.state === 'cancelling') {
          const cancelled = {
            ...latest,
            state: 'cancelled' as const,
            completedAt: nowIso(),
            stateRevision: latest.stateRevision + 1,
            userMessageId
          }
          this.ports.turns.update(cancelled)
          this.publishTurn(cancelled, null)
          this.publishRealtime(conversationTurnTopic(turnId), 'turn.cancelled', {
            turn: toRealtimeTurnDto(cancelled)
          })
          return
        }
        if (event.type === 'text_delta') {
          if (reply.length + event.text.length > MAX_ASSISTANT_REPLY_CHARS) {
            reply = truncateOutput(`${reply}${event.text}`, MAX_ASSISTANT_REPLY_CHARS)
            await this.ports.agentRuntime.abort(turnId, 'conversation.output_limit')
            break
          }
          reply += event.text
          this.publishRealtime(conversationTurnTopic(turnId), 'assistant.text.delta', {
            content: event.text
          })
        } else if (event.type === 'thinking_delta') {
          if (!thinkingStarted) thinkingStarted = Date.now()
          if (thinking.length + event.text.length > MAX_ASSISTANT_THINKING_CHARS) {
            thinking = truncateOutput(`${thinking}${event.text}`, MAX_ASSISTANT_THINKING_CHARS)
            await this.ports.agentRuntime.abort(turnId, 'conversation.thinking_limit')
            break
          }
          thinking += event.text
          this.publishRealtime(conversationTurnTopic(turnId), 'assistant.thinking.delta', {
            content: event.text
          })
        } else if (event.type === 'completed') {
          reply = truncateOutput(event.reply ?? reply, MAX_ASSISTANT_REPLY_CHARS)
        } else if (event.type === 'failed') {
          throw new Error(event.message)
        }
      }

      const beforeCommit = this.ports.turns.get(turnId)
      if (beforeCommit?.state === 'cancelling' || controller.signal.aborted) {
        if (timedOut) {
          this.failTurn(beforeCommit ?? running, 'Conversation turn timed out')
        } else {
          this.finishCancelled(beforeCommit ?? running, userMessageId)
        }
        return
      }

      const committing: TurnRecord = {
        ...running,
        state: 'committing',
        userMessageId,
        stateRevision: running.stateRevision + 1
      }
      const assistantId = newId('msg')
      const assistantCreatedAt = nowIso()
      const completed: TurnRecord = {
        ...committing,
        state: 'completed',
        assistantMessageId: assistantId,
        completedAt: nowIso(),
        stateRevision: committing.stateRevision + 1
      }
      this.ports.transaction(() => {
        this.ports.turns.update(committing)
        this.ports.messages.insert({
          id: assistantId,
          conversationId: conversation.id,
          turnId,
          role: 'assistant',
          kind: 'text',
          content: reply,
          providerCode: turn.providerCode,
          model: null,
          thinkingText: thinking || null,
          thinkingDurationMs: thinkingStarted ? Date.now() - thinkingStarted : null,
          createdAt: assistantCreatedAt
        })
        this.ports.turns.update(completed)
        const currentConversation = this.ports.conversations.get(conversation.id)
        if (!currentConversation) throw new Error('Conversation disappeared while committing')
        const touchedAt = nowIso()
        this.ports.conversations.update({
          ...currentConversation,
          lastUsedAt: touchedAt,
          updatedAt: touchedAt
        })
      })

      this.publishRealtime(conversationTopic(conversation.id), 'message.committed', {
        message: toMessageDto({
          id: assistantId,
          conversationId: conversation.id,
          turnId,
          role: 'assistant',
          kind: 'text',
          content: reply,
          providerCode: turn.providerCode,
          model: null,
          thinkingText: thinking || null,
          thinkingDurationMs: thinkingStarted ? Date.now() - thinkingStarted : null,
          createdAt: assistantCreatedAt
        })
      })
      this.publishTurn(completed, null)
      this.publishRealtime(conversationTurnTopic(turnId), 'turn.completed', {
        turn: toRealtimeTurnDto(completed)
      })
    } catch (error) {
      const latest = this.ports.turns.get(turnId)
      if (timedOut) {
        this.failTurn(latest ?? running, 'Conversation turn timed out')
      } else if (latest?.state === 'cancelling' || controller.signal.aborted) {
        this.finishCancelled(latest ?? running)
      } else {
        this.failTurn(latest ?? running, error instanceof Error ? error.message : String(error))
      }
    } finally {
      clearTimeout(turnTimeout)
      releaseSystemMcp?.()
      if (leaseId) this.ports.leases.release(leaseId)
      if (this.abortControllers.get(turnId) === controller) this.abortControllers.delete(turnId)
      void this.advanceQueue(turn.actorId)
    }
  }

  private failTurn(turn: TurnRecord, message: string): void {
    const failed: TurnRecord = {
      ...turn,
      state: 'failed',
      completedAt: nowIso(),
      lastErrorJson: JSON.stringify({ code: 'runtime.failed', message }),
      stateRevision: turn.stateRevision + 1
    }
    this.ports.turns.update(failed)
    this.publishTurn(failed, null)
    this.publishRealtime(conversationTurnTopic(turn.id), 'turn.failed', {
      turn: toRealtimeTurnDto(failed)
    })
  }

  private finishCancelled(turn: TurnRecord, userMessageId?: string): void {
    const cancelled: TurnRecord = {
      ...turn,
      state: 'cancelled',
      completedAt: nowIso(),
      stateRevision: turn.stateRevision + 1,
      ...(userMessageId ? { userMessageId } : {})
    }
    this.ports.turns.update(cancelled)
    this.publishTurn(cancelled, null)
    this.publishRealtime(conversationTurnTopic(turn.id), 'turn.cancelled', {
      turn: toRealtimeTurnDto(cancelled)
    })
  }

  private publishTurn(turn: TurnRecord, queuePosition: number | null): void {
    this.publishRealtime(conversationTurnTopic(turn.id), 'turn.changed', {
      turn: toRealtimeTurnDto(turn, queuePosition)
    })
  }

  private publishRealtime(topic: string, event: string, payload: Record<string, unknown>): void {
    try {
      this.ports.realtime.publish(topic, event, payload)
    } catch (error) {
      // Realtime delivery is secondary to the durable command state. A transient
      // event-log/fanout failure must never strand an accepted turn.
      console.error('[conversation] realtime publish failed', { topic, event, error })
    }
  }

  private requireOwned(actor: Actor, conversationId: string): ConversationRecord {
    const row = this.ports.conversations.get(conversationId)
    if (!row) throw new ConversationNotFoundError('Conversation not found')
    if (row.actorId !== actor.userId) throw new ConversationForbiddenError()
    return row
  }
}
