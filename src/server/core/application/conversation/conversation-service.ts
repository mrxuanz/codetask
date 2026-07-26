import type {
  Clock,
  ConversationMessageRecord,
  ConversationSettingsRecord,
  ConversationThreadRecord,
  ConversationTurnRecord,
  ConversationWorkspaceRecord,
  IdGenerator,
  UnitOfWork
} from '../ports'
import {
  ConversationError,
  titleFromPrompt,
  validateConversationModel,
  validateConversationPrompt,
  validateConversationTitle
} from '../../domain/conversation'

export interface BeginConversationTurnResult {
  readonly workspace: ConversationWorkspaceRecord
  readonly thread: ConversationThreadRecord
  readonly turn: ConversationTurnRecord
  readonly prompt: string
}

export class ConversationService {
  constructor(
    private readonly dependencies: {
      readonly unitOfWork: UnitOfWork
      readonly clock: Clock
      readonly ids: IdGenerator
    }
  ) {}

  getSettings(userId: string): ConversationSettingsRecord {
    return (
      this.dependencies.unitOfWork.transaction((tx) => tx.conversation.getSettings(userId)) ?? {
        userId,
        provider: 'cursorcli',
        model: null,
        revision: 0,
        updatedAtMs: 0
      }
    )
  }

  updateSettings(
    userId: string,
    input: { readonly model?: string | null }
  ): ConversationSettingsRecord {
    const model = validateConversationModel(input.model)
    const nowMs = this.dependencies.clock.nowMs()
    return this.dependencies.unitOfWork.transaction((tx) => {
      const current = tx.conversation.getSettings(userId)
      const record: ConversationSettingsRecord = {
        userId,
        provider: 'cursorcli',
        model,
        revision: (current?.revision ?? 0) + 1,
        updatedAtMs: nowMs
      }
      tx.conversation.putSettings(record)
      return record
    })
  }

  listWorkspaces(userId: string): ConversationWorkspaceRecord[] {
    return this.dependencies.unitOfWork.transaction((tx) => tx.conversation.listWorkspaces(userId))
  }

  createWorkspace(
    userId: string,
    input: { readonly rootPath: string; readonly canonicalKey: string; readonly title: string }
  ): ConversationWorkspaceRecord {
    const title = validateConversationTitle(input.title)
    const nowMs = this.dependencies.clock.nowMs()
    return this.dependencies.unitOfWork.transaction((tx) => {
      const existing = tx.conversation.getWorkspaceByCanonicalKey(userId, input.canonicalKey)
      if (existing) {
        throw new ConversationError('conversation.workspace_exists', {
          workspaceId: existing.id
        })
      }
      const record: ConversationWorkspaceRecord = {
        id: this.dependencies.ids.generate(),
        userId,
        title,
        rootPath: input.rootPath,
        canonicalKey: input.canonicalKey,
        createdAtMs: nowMs,
        updatedAtMs: nowMs
      }
      tx.conversation.insertWorkspace(record)
      return record
    })
  }

  deleteWorkspace(userId: string, workspaceId: string): void {
    const deleted = this.dependencies.unitOfWork.transaction((tx) =>
      tx.conversation.deleteWorkspace(userId, workspaceId)
    )
    if (!deleted) throw new ConversationError('conversation.workspace_not_found')
  }

  listThreads(userId: string, workspaceId: string): ConversationThreadRecord[] {
    return this.dependencies.unitOfWork.transaction((tx) => {
      if (!tx.conversation.getWorkspace(userId, workspaceId)) {
        throw new ConversationError('conversation.workspace_not_found')
      }
      return tx.conversation.listThreads(userId, workspaceId)
    })
  }

  createThread(
    userId: string,
    input: { readonly workspaceId: string; readonly title?: string }
  ): ConversationThreadRecord {
    const title = validateConversationTitle(input.title ?? 'New conversation')
    const settings = this.getSettings(userId)
    const nowMs = this.dependencies.clock.nowMs()
    return this.dependencies.unitOfWork.transaction((tx) => {
      if (!tx.conversation.getWorkspace(userId, input.workspaceId)) {
        throw new ConversationError('conversation.workspace_not_found')
      }
      const record: ConversationThreadRecord = {
        id: this.dependencies.ids.generate(),
        workspaceId: input.workspaceId,
        title,
        provider: 'cursorcli',
        model: settings.model,
        runtimeSessionId: null,
        createdAtMs: nowMs,
        updatedAtMs: nowMs,
        lastMessageAtMs: null
      }
      tx.conversation.insertThread(record)
      return record
    })
  }

  renameThread(userId: string, threadId: string, titleInput: string): void {
    const title = validateConversationTitle(titleInput)
    const updated = this.dependencies.unitOfWork.transaction((tx) =>
      tx.conversation.updateThreadTitle(userId, threadId, title, this.dependencies.clock.nowMs())
    )
    if (!updated) throw new ConversationError('conversation.thread_not_found')
  }

  deleteThread(userId: string, threadId: string): void {
    const deleted = this.dependencies.unitOfWork.transaction((tx) =>
      tx.conversation.deleteThread(userId, threadId)
    )
    if (!deleted) throw new ConversationError('conversation.thread_not_found')
  }

  listMessages(userId: string, threadId: string): ConversationMessageRecord[] {
    return this.dependencies.unitOfWork.transaction((tx) => {
      if (!tx.conversation.getThread(userId, threadId)) {
        throw new ConversationError('conversation.thread_not_found')
      }
      return tx.conversation.listMessages(userId, threadId)
    })
  }

  beginTurn(userId: string, threadId: string, promptInput: string): BeginConversationTurnResult {
    const prompt = validateConversationPrompt(promptInput)
    const settings = this.getSettings(userId)
    const nowMs = this.dependencies.clock.nowMs()
    return this.dependencies.unitOfWork.transaction((tx) => {
      const thread = tx.conversation.getThread(userId, threadId)
      if (!thread) throw new ConversationError('conversation.thread_not_found')
      const workspace = tx.conversation.getWorkspace(userId, thread.workspaceId)
      if (!workspace) throw new ConversationError('conversation.workspace_not_found')
      if (tx.conversation.getRunningTurn(threadId)) {
        throw new ConversationError('conversation.turn_in_progress')
      }

      const sequence = tx.conversation.nextMessageSequence(threadId)
      const userMessage: ConversationMessageRecord = {
        id: this.dependencies.ids.generate(),
        threadId,
        role: 'user',
        content: prompt,
        sequence,
        createdAtMs: nowMs
      }
      const turn: ConversationTurnRecord = {
        id: this.dependencies.ids.generate(),
        threadId,
        userMessageId: userMessage.id,
        state: 'running',
        provider: 'cursorcli',
        model: settings.model,
        errorCode: null,
        errorMessage: null,
        startedAtMs: nowMs,
        finishedAtMs: null
      }
      tx.conversation.insertMessage(userMessage)
      tx.conversation.insertTurn(turn)
      if (thread.lastMessageAtMs === null && thread.title === 'New conversation') {
        tx.conversation.updateThreadTitle(userId, threadId, titleFromPrompt(prompt), nowMs)
      }
      return { workspace, thread: { ...thread, model: settings.model }, turn, prompt }
    })
  }

  completeTurn(input: {
    readonly turnId: string
    readonly threadId: string
    readonly reply: string
    readonly runtimeSessionId: string | null
  }): ConversationMessageRecord {
    const nowMs = this.dependencies.clock.nowMs()
    return this.dependencies.unitOfWork.transaction((tx) => {
      const assistantMessage: ConversationMessageRecord = {
        id: this.dependencies.ids.generate(),
        threadId: input.threadId,
        role: 'assistant',
        content: input.reply,
        sequence: tx.conversation.nextMessageSequence(input.threadId),
        createdAtMs: nowMs
      }
      const completed = tx.conversation.completeTurn({
        turnId: input.turnId,
        threadId: input.threadId,
        assistantMessage,
        runtimeSessionId: input.runtimeSessionId,
        finishedAtMs: nowMs
      })
      if (!completed) throw new ConversationError('conversation.turn_not_found')
      return assistantMessage
    })
  }

  failTurn(
    turnId: string,
    input: { readonly cancelled: boolean; readonly code: string; readonly message: string }
  ): void {
    const failed = this.dependencies.unitOfWork.transaction((tx) =>
      tx.conversation.failTurn({
        turnId,
        state: input.cancelled ? 'cancelled' : 'failed',
        errorCode: input.code.slice(0, 160),
        errorMessage: input.message.slice(0, 2_000),
        finishedAtMs: this.dependencies.clock.nowMs()
      })
    )
    if (!failed) throw new ConversationError('conversation.turn_not_found')
  }
}
