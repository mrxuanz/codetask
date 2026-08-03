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
import { conversationTopic, conversationTurnTopic } from '@codetask/contracts'
import {
  ACTIVE_TURN_STATES,
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

export class ConversationApplication {
  private readonly abortControllers = new Map<string, AbortController>()
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
    return this.ports.conversations
      .listForProject(actor.userId, projectId)
      .map(toConversationDto)
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
    const row: ConversationRecord = {
      id: newId('conv'),
      actorId: actor.userId,
      projectId,
      title: input.title?.trim() || DEFAULT_TITLE,
      titleSource: input.title?.trim() ? 'manual' : 'auto',
      providerCode: input.providerCode ?? this.ports.defaultProviderCode,
      state: 'active',
      stateRevision: 0,
      createdAt: now,
      updatedAt: now,
      lastUsedAt: null
    }
    this.ports.conversations.insert(row)
    const dto = toConversationDto(row)
    this.ports.realtime.publish(conversationTopic(row.id), 'conversation.changed', {
      conversation: dto
    })
    return dto
  }

  rename(actor: Actor, conversationId: string, title: string): ConversationDto {
    const trimmed = title.trim()
    if (!trimmed) throw new ConversationValidationError('Title cannot be empty')
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
    this.ports.realtime.publish(conversationTopic(row.id), 'conversation.changed', {
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
    this.ports.realtime.publish(conversationTopic(row.id), 'conversation.changed', {
      conversation: dto
    })
    return dto
  }

  async delete(actor: Actor, conversationId: string): Promise<void> {
    const row = this.requireOwned(actor, conversationId)
    const active = this.ports.turns
      .listQueued(actor.userId)
      .concat(
        ...ACTIVE_TURN_STATES.flatMap((state) => {
          const turn = this.ports.turns.get(conversationId)
          return turn && turn.state === state ? [turn] : []
        })
      )
    void active
    // Cancel in-flight via abort map
    for (const [turnId, controller] of this.abortControllers) {
      const turn = this.ports.turns.get(turnId)
      if (turn?.conversationId === conversationId) controller.abort('conversation.deleted')
    }
    await this.ports.agentRuntime.closeScope(
      buildConversationScopeId(row.id, row.providerCode as RuntimeProviderCode)
    )
    this.ports.turns.deleteForConversation(conversationId)
    this.ports.messages.deleteForConversation(conversationId)
    this.ports.conversations.delete(conversationId)
    this.ports.realtime.publish(conversationTopic(conversationId), 'conversation.deleted', {
      conversationId
    })
  }

  listMessages(actor: Actor, conversationId: string, limit = 100): ConversationMessageDto[] {
    this.requireOwned(actor, conversationId)
    return this.ports.messages.list(conversationId, limit).map(toMessageDto)
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
        throw new ConversationConflictError('Idempotency key was already used for another conversation')
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
      this.ports.realtime.publish(conversationTurnTopic(turnId), 'turn.cancelled', {
        turn: toTurnDto(next)
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
    if (this.advancing) return
    this.advancing = true
    try {
      const queued = this.ports.turns.listQueued(actorId)
      for (const row of queued) {
        if (this.ports.turns.hasActiveForConversation(row.conversationId)) continue
        if (this.ports.turns.countActiveForActor(row.actorId) >= this.ports.maxConcurrentTurnsPerUser) {
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
        // Optimistic CAS via revision check
        const current = this.ports.turns.get(row.id)
        if (!current || current.state !== 'queued') continue
        this.ports.turns.update(admitted)
        this.publishTurn(admitted, null)
        void this.runAdmittedTurn(admitted.id)
      }
    } finally {
      this.advancing = false
    }
  }

  reconcileOnStartup(): void {
    const queued = this.ports.turns.listQueued()
    for (const turn of queued) {
      // keep queued
      void turn
    }
    // Mark interrupted active turns failed
    for (const actorTurns of [this.ports.turns.listQueued()]) {
      void actorTurns
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
      this.ports.realtime.publish(conversationTopic(conversation.id), 'message.committed', {
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
        this.ports.realtime.publish(conversationTopic(conversation.id), 'conversation.changed', {
          conversation: toConversationDto(updatedConv)
        })
      }

      const history = this.ports.messages.list(conversation.id, MAX_HISTORY_MESSAGES)
      const policy = contextPolicyFor('conversation', capabilityProfile)
      const historyBlock = policy.requiresHistorySeed
        ? history
            .filter((m) => m.id !== userMessageId)
            .map((m) => `${m.role}: ${m.content}`)
            .join('\n')
        : ''
      const basePrompt = historyBlock
        ? `${historyBlock}\nuser: ${turn.inputText}`
        : turn.inputText
      const prompt = resolvedAttachments.promptAppendix
        ? `${basePrompt}\n\n${resolvedAttachments.promptAppendix}`
        : basePrompt

      const scopeId = buildConversationScopeId(
        conversation.id,
        turn.providerCode as RuntimeProviderCode
      )
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
          this.ports.realtime.publish(conversationTurnTopic(turnId), 'turn.cancelled', {
            turn: toTurnDto(cancelled)
          })
          return
        }
        if (event.type === 'text_delta') {
          reply += event.text
          this.ports.realtime.publish(conversationTurnTopic(turnId), 'assistant.text.delta', {
            content: event.text
          })
        } else if (event.type === 'thinking_delta') {
          if (!thinkingStarted) thinkingStarted = Date.now()
          thinking += event.text
          this.ports.realtime.publish(conversationTurnTopic(turnId), 'assistant.thinking.delta', {
            content: event.text
          })
        } else if (event.type === 'completed') {
          reply = event.reply ?? reply
        } else if (event.type === 'failed') {
          throw new Error(event.message)
        }
      }

      const committing: TurnRecord = {
        ...running,
        state: 'committing',
        userMessageId,
        stateRevision: running.stateRevision + 1
      }
      this.ports.turns.update(committing)

      const assistantId = newId('msg')
      const assistantCreatedAt = nowIso()
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

      const completed: TurnRecord = {
        ...committing,
        state: 'completed',
        assistantMessageId: assistantId,
        completedAt: nowIso(),
        stateRevision: committing.stateRevision + 1
      }
      this.ports.turns.update(completed)

      const touched = {
        ...this.ports.conversations.get(conversation.id)!,
        lastUsedAt: nowIso(),
        updatedAt: nowIso()
      }
      this.ports.conversations.update(touched)

      this.ports.realtime.publish(conversationTopic(conversation.id), 'message.committed', {
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
      this.ports.realtime.publish(conversationTurnTopic(turnId), 'turn.completed', {
        turn: toTurnDto(completed)
      })
    } catch (error) {
      const latest = this.ports.turns.get(turnId)
      if (latest?.state === 'cancelling' || controller.signal.aborted) {
        const cancelled = {
          ...(latest ?? running),
          state: 'cancelled' as const,
          completedAt: nowIso(),
          stateRevision: (latest ?? running).stateRevision + 1
        }
        this.ports.turns.update(cancelled)
        this.publishTurn(cancelled, null)
        this.ports.realtime.publish(conversationTurnTopic(turnId), 'turn.cancelled', {
          turn: toTurnDto(cancelled)
        })
      } else {
        this.failTurn(latest ?? running, error instanceof Error ? error.message : String(error))
      }
    } finally {
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
    this.ports.realtime.publish(conversationTurnTopic(turn.id), 'turn.failed', {
      turn: toTurnDto(failed)
    })
  }

  private publishTurn(turn: TurnRecord, queuePosition: number | null): void {
    const dto = toTurnDto(turn, queuePosition)
    this.ports.realtime.publish(conversationTurnTopic(turn.id), 'turn.changed', { turn: dto })
  }

  private requireOwned(actor: Actor, conversationId: string): ConversationRecord {
    const row = this.ports.conversations.get(conversationId)
    if (!row) throw new ConversationNotFoundError('Conversation not found')
    if (row.actorId !== actor.userId) throw new ConversationForbiddenError()
    return row
  }
}
