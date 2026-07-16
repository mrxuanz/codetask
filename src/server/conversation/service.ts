import { randomUUID } from 'crypto'
import { buildMessageThinkingPayload } from '../../shared/message-thinking'
import { AppError } from '../error'
import { memoryDebug } from '../debug/memory'
import { getProject } from '../projects/service'
import {
  getThread,
  getThreadRow,
  reconcileStaleThreadRuntime,
  resolveThreadKind,
  toThreadDto,
  updateThreadCore,
  updateThreadRuntime
} from '../threads/service'
import type { ThreadDto } from '../threads/types'
import {
  RUNTIME_STATUS_ERROR,
  RUNTIME_STATUS_IDLE,
  RUNTIME_STATUS_RUNNING,
  THREAD_KIND_CHAT,
  THREAD_KIND_CREATE_TASK
} from '../threads/types'
import type { ThreadKind } from '../threads/types'
import { ensureCoreAvailable, getAgentCore, listChatCores, type SupportedCoreCode } from './cores'
import { buildConversationMcpUrl } from './mcp/url'
import {
  registerConversationMcpSession,
  unregisterConversationMcpSession,
  type ConversationTurnRole
} from './mcp/session'
import {
  augmentPromptWithHistory,
  buildConversationHistoryBlock,
  isFirstWizardPhaseTurn,
  shouldSeedConversationHistory
} from './history'
import { insertMessage, listMessages, getMessage } from './messages'
import { resolveCoreModel } from './models'
import { buildConversationSystemPrompt, buildDraftTurnSystemPrompt } from './prompts'
import { buildWizardContextSnapshot, buildWizardPhasePromptSection } from '../wizard/prompts'
import { getDesignSessionRow } from '../design-session/service'
import { getThreadPhaseRuntime, resolveWizardPhase } from '../wizard/phase'
import { WIZARD_PHASE_COLLECT } from '../wizard/types'
import { toolsForWizardPhase } from '../wizard/tools'
import type { WizardPhase } from '../wizard/types'
import { buildWorkspaceSnapshot } from './workspace-snapshot'
import type { TaskLaunchDraftPayload } from './draft/types'
import { ensureCollectingDraft } from './draft/collecting'
import { formatSdkTurnError, toTurnErrorDto } from '../agent-runtime/errors'
import { ensureConversationRuntimeRoot, streamAgentTurn } from '../agent-runtime/runner'
import { appendTextPiece, MAX_TURN_TEXT_CHARS } from '../agent-runtime/delta-emit'
import { ensureIsolatedProviderDirs } from '../agent-runtime/env'
import { buildConversationCursorRuntimeScope } from '../agent-runtime/cursor-acp/runtime-registry'
import { closeConversationCursorRuntime } from '../agent-runtime/cursor-acp/stream-session-turn'
import type {
  ChatSseEvent,
  ConversationMessageDto,
  ConversationStateDto,
  MessageAttachment
} from './types'
import { buildAttachmentReferenceMarkdown, resolveTurnAttachmentReadRoots } from './attachments'
import { getAppContext } from '../bootstrap'
import { assertConcurrentTurnCapacity } from '../middleware/http-limits'
import { maybeSeedThreadTitleFromFirstMessage } from './thread-title'

export function initConversationService(_options: { dataDir: string }): void {
  getAppContext()
}

/**
 * Server-side mode truth (FIX-PLAN §1.2). `threadKind` from the database is
 * the only authority; client-supplied booleans (generateDraft, createTaskMode)
 * are requests that must be validated against it, never trusted directly.
 */
export type ConversationMode =
  | { kind: typeof THREAD_KIND_CHAT; generateDraft: false }
  | { kind: typeof THREAD_KIND_CREATE_TASK; generateDraft: boolean }

export function assertConversationMode(input: {
  threadKind: ThreadKind
  requestedCreateTaskMode: boolean
  requestedDraft: boolean
}): void {
  const requestIsCreateTask = input.requestedCreateTaskMode || input.requestedDraft
  const threadIsCreateTask = input.threadKind === THREAD_KIND_CREATE_TASK

  if (requestIsCreateTask !== threadIsCreateTask) {
    throw AppError.conflict(
      'Conversation mode does not match thread kind',
      {
        expected: input.threadKind,
        requested: requestIsCreateTask ? THREAD_KIND_CREATE_TASK : THREAD_KIND_CHAT
      },
      'conversation.mode_mismatch'
    )
  }
}

export function resolveConversationMode(input: {
  threadKind: ThreadKind
  requestedDraft: boolean
}): ConversationMode {
  if (input.threadKind === THREAD_KIND_CHAT && input.requestedDraft) {
    throw AppError.conflict(
      'Chat threads cannot start draft turns',
      { threadKind: input.threadKind },
      'conversation.mode_mismatch',
      { threadKind: input.threadKind }
    )
  }
  return input.threadKind === THREAD_KIND_CHAT
    ? { kind: THREAD_KIND_CHAT, generateDraft: false }
    : { kind: THREAD_KIND_CREATE_TASK, generateDraft: input.requestedDraft }
}

export interface PreparedConversationTurn {
  username: string
  threadId: string
  thread: ThreadDto
  threadRow: NonNullable<Awaited<ReturnType<typeof getThreadRow>>>
  workspacePath: string
  threadKind: ThreadKind
  createTaskMode: boolean
  conversationMode: ConversationMode
  wizardPhase: WizardPhase
  /** Null when conversation uses read-only access and does not hold an exclusive lease. */
  workspaceLeaseId: string | null
  workspaceAccess: import('../../shared/workspace-access.ts').WorkspaceAccessMode
  changeSetId: string | null
  runtimeRootOverride: string | null
}

export async function prepareConversationTurn(input: {
  username: string
  threadId: string
  requestedCreateTaskMode: boolean
  requestedDraft: boolean
}): Promise<PreparedConversationTurn> {
  const { username, threadId, requestedCreateTaskMode, requestedDraft } = input

  const resolved = await loadThreadProject(username, threadId)
  let thread = resolved.thread
  const workspacePath = resolved.workspacePath

  const { isThreadProjectDeletionBlocked } =
    await import('../legacy-control-plane/deletion-coordinator')
  if (await isThreadProjectDeletionBlocked(threadId)) {
    throw AppError.conflict('Project or thread is being deleted', undefined, 'thread.deleting')
  }

  const threadRow = await getThreadRow(username, threadId)
  if (!threadRow) {
    throw AppError.notFound('Thread not found', 'thread.not_found')
  }

  const threadKind = resolveThreadKind(threadRow)
  assertConversationMode({ threadKind, requestedCreateTaskMode, requestedDraft })
  const conversationMode = resolveConversationMode({ threadKind, requestedDraft })
  const createTaskMode = threadKind === THREAD_KIND_CREATE_TASK
  const wizardPhase = resolveWizardPhase(threadRow)
  const { conversationWorkspaceAccess } = await import('../../shared/workspace-access.ts')
  // Chat/draft need project context as live-read; they never take exclusive-write.
  const workspaceAccess = conversationWorkspaceAccess(Boolean(workspacePath))

  thread = await reconcileStaleThreadRuntime(username, thread, isThreadInflight)
  reserveThread(thread, username)

  try {
    // Read-only conversation must not compete for the exclusive workspace write lease.
    return {
      username,
      threadId: thread.id,
      thread,
      threadRow,
      workspacePath,
      threadKind,
      createTaskMode,
      conversationMode,
      wizardPhase,
      workspaceLeaseId: null,
      workspaceAccess,
      changeSetId: null,
      runtimeRootOverride: null
    }
  } catch (error) {
    releaseThread(threadId)
    throw error
  }
}

function isThreadInflight(threadId: string): boolean {
  return getAppContext().runtimeRegistry.isThreadInflight(threadId)
}

function buildThreadState(
  thread: ThreadDto,
  workspacePath: string,
  core: Awaited<ReturnType<typeof getAgentCore>>,
  pendingCount: number
): ConversationStateDto {
  return {
    configured: true,
    agent: {
      name: 'conversation',
      workspacePath,
      coreCode: thread.coreCode,
      updatedAt: new Date(thread.updatedAt * 1000).toISOString()
    },
    sessionId: thread.conversationId,
    conversationId: thread.conversationId,
    runtimeSessionId: thread.runtimeSessionId,
    runtimeStatus: thread.runtimeStatus,
    lastError: thread.lastError,
    lastUsedAt: thread.lastUsedAt ? new Date(thread.lastUsedAt * 1000).toISOString() : null,
    pendingCount,
    core: core
      ? {
          code: core.code,
          label: core.label,
          description: core.description,
          available: core.available,
          reason: core.reason,
          detectedCommand: core.detectedCommand,
          launchCommand: core.launchCommand,
          executablePath: core.executablePath
        }
      : null
  }
}

async function loadThreadProject(
  username: string,
  threadId: string
): Promise<{ thread: ThreadDto; workspacePath: string }> {
  const row = await getThreadRow(username, threadId)
  if (!row) {
    throw AppError.notFound('Thread not found', 'thread.not_found')
  }
  const project = await getProject(username, row.projectId)
  if (!project) {
    throw AppError.notFound('Project not found', 'project.not_found')
  }
  return { thread: toThreadDto(row), workspacePath: project.workspaceRoot }
}

function reserveThread(thread: ThreadDto, username: string): void {
  const ctx = getAppContext()
  const registry = ctx.runtimeRegistry
  assertConcurrentTurnCapacity(
    registry.countInflightForUser(username),
    ctx.config.http.maxConcurrentTurnsPerUser
  )
  if (registry.isThreadInflight(thread.id)) {
    throw AppError.badRequest('Thread is busy; wait for the reply to finish', 'thread.busy')
  }
  if (thread.runtimeStatus === RUNTIME_STATUS_RUNNING) {
    throw AppError.badRequest('Thread is busy; wait for the reply to finish', 'thread.busy')
  }
  registry.addInflightThread(thread.id, username)
}

function releaseThread(threadId: string): void {
  getAppContext().runtimeRegistry.removeInflightThread(threadId)
}

export async function listCores(): Promise<ReturnType<typeof listChatCores>> {
  return listChatCores()
}

export async function loadThreadState(
  username: string,
  threadId: string
): Promise<ConversationStateDto> {
  const { thread, workspacePath } = await loadThreadProject(username, threadId)
  const reconciled = await reconcileStaleThreadRuntime(username, thread, isThreadInflight)
  const core = await getAgentCore(reconciled.coreCode)
  const pendingCount = isThreadInflight(threadId) ? 1 : 0
  return buildThreadState(reconciled, workspacePath, core, pendingCount)
}

export async function listThreadMessages(
  username: string,
  threadId: string,
  limit: number
): Promise<ConversationMessageDto[]> {
  const row = await getThread(username, threadId)
  if (!row) {
    throw AppError.notFound('Thread not found', 'thread.not_found')
  }
  return listMessages(username, threadId, limit)
}

export async function switchThreadCore(
  username: string,
  threadId: string,
  coreCode: string
): Promise<ThreadDto> {
  await closeConversationCursorRuntime(threadId)
  await ensureCoreAvailable(coreCode).catch((error: Error) => {
    throw AppError.badRequest(error.message)
  })
  return updateThreadCore(username, threadId, coreCode)
}

export async function* streamSendMessage(
  username: string,
  threadId: string,
  message: string,
  options?: {
    generateDraft?: boolean
    createTaskMode?: boolean
    attachments?: MessageAttachment[]
    selectedDraftSection?: string
    selectedPlanNodeRef?: string
    signal?: AbortSignal
    workspacePathOverride?: string
    runtimeRootOverride?: string
    changeSetId?: string
  }
): AsyncGenerator<ChatSseEvent> {
  const basePrepared = await prepareConversationTurn({
    username,
    threadId,
    requestedCreateTaskMode: options?.createTaskMode === true,
    requestedDraft: options?.generateDraft === true
  })
  const prepared: PreparedConversationTurn = options?.workspacePathOverride
    ? {
        ...basePrepared,
        workspacePath: options.workspacePathOverride,
        workspaceAccess: 'isolated-write',
        changeSetId: options.changeSetId ?? null,
        runtimeRootOverride: options.runtimeRootOverride ?? null
      }
    : basePrepared
  yield* executePreparedTurn(prepared, message, options)
}

export async function* executePreparedTurn(
  prepared: PreparedConversationTurn,
  message: string,
  options?: {
    attachments?: MessageAttachment[]
    selectedDraftSection?: string
    selectedPlanNodeRef?: string
    signal?: AbortSignal
  }
): AsyncGenerator<ChatSseEvent> {
  const trimmed = message.trim()
  if (!trimmed) {
    throw AppError.badRequest('Message cannot be empty', 'message.empty')
  }

  const { username, threadId, workspacePath, threadKind, createTaskMode, conversationMode } =
    prepared
  let thread = prepared.thread
  const threadRow = prepared.threadRow
  const wizardPhase = prepared.wizardPhase

  const { enterWorkspaceLeaseContext } =
    await import('../legacy-control-plane/workspace-lease-context')
  if (prepared.workspaceLeaseId) {
    enterWorkspaceLeaseContext({
      leaseId: prepared.workspaceLeaseId,
      ownerKind: 'conversation',
      ownerId: thread.id
    })
  }

  try {
    const core = await ensureCoreAvailable(thread.coreCode).catch((error: Error) => {
      throw AppError.badRequest(error.message)
    })

    const turnAttachments = options?.attachments ?? []

    const userMessage = await insertMessage({
      threadId: thread.id,
      username,
      role: 'user',
      kind: 'text',
      content: trimmed,
      coreCode: thread.coreCode,
      conversationId: thread.conversationId,
      runtimeSessionId: thread.runtimeSessionId,
      attachments: turnAttachments,
      wizardPhase: createTaskMode ? wizardPhase : null
    })

    yield { event: 'user_message', data: { message: userMessage } }

    if (!createTaskMode && threadKind === THREAD_KIND_CHAT) {
      try {
        const firstImage = turnAttachments.find((attachment) =>
          attachment.mimeType?.startsWith('image/')
        )
        const seededThread = await maybeSeedThreadTitleFromFirstMessage(username, thread.id, {
          userMessage: trimmed,
          imageAttachmentName: firstImage?.name ?? null
        })
        if (seededThread) {
          thread = seededThread
          yield { event: 'thread_updated', data: { thread: seededThread } }
        }
      } catch {
        // best-effort, ignore errors
      }
    }

    if (createTaskMode && wizardPhase === WIZARD_PHASE_COLLECT) {
      const { message: collectingDraft, created } = await ensureCollectingDraft({
        username,
        threadId: thread.id,
        threadTitle: thread.title,
        sourceMessageId: userMessage.id,
        workspacePath,
        coreCode: thread.coreCode,
        conversationId: thread.conversationId
      })
      if (created) {
        yield { event: 'draft_message', data: { message: collectingDraft } }
      }
      const refreshed = await getThread(username, thread.id)
      if (refreshed) {
        thread = refreshed
      }
    }

    thread = await updateThreadRuntime(
      username,
      thread.id,
      thread.coreCode,
      thread.runtimeSessionId,
      RUNTIME_STATUS_RUNNING,
      null
    )

    const conversationKind = createTaskMode ? 'create_task' : 'chat'
    const runtimeRoot = prepared.runtimeRootOverride
      ? prepared.runtimeRootOverride
      : ensureConversationRuntimeRoot(
          getAppContext().dataDir,
          thread.id,
          conversationKind,
          core.code as SupportedCoreCode
        )
    if (prepared.runtimeRootOverride) ensureIsolatedProviderDirs(runtimeRoot)
    const model = resolveCoreModel(core.code as SupportedCoreCode)
    const turnRole: ConversationTurnRole = conversationMode.generateDraft ? 'draft' : 'chat'
    const wizardStage: WizardPhase | null = createTaskMode ? wizardPhase : null
    const mcpWizardStage = wizardStage ?? 'general'
    const phaseRuntimeId = createTaskMode
      ? (getThreadPhaseRuntime(threadRow) ?? thread.runtimeSessionId)
      : thread.runtimeSessionId
    const priorMessages = await listMessages(username, thread.id, 50, { signAssets: false })

    const draftEvents: ChatSseEvent[] = []
    const mcpSessionId = createTaskMode ? `conv-mcp-${thread.id}` : null
    if (createTaskMode && mcpSessionId) {
      registerConversationMcpSession({
        sessionId: mcpSessionId,
        username,
        threadId: thread.id,
        turnRole,
        wizardStage,
        workspacePath,
        userMessageId: userMessage.id,
        conversationId: thread.conversationId,
        coreCode: thread.coreCode,
        turnAttachments,
        activeDraftId: thread.activeDraftId ?? null,
        activePlanId: thread.activePlanId ?? null,
        onDraftCreated: (draftMessage) => {
          draftEvents.push({ event: 'draft_message', data: { message: draftMessage } })
        },
        onPlanUpdated: (job) => {
          draftEvents.push({ event: 'plan_updated', data: { job } })
        }
      })
    }

    let mcpUrl: string | undefined
    if (createTaskMode && mcpSessionId) {
      try {
        mcpUrl = buildConversationMcpUrl({
          sessionId: mcpSessionId,
          threadId: thread.id,
          wizardStage: mcpWizardStage
        })
      } catch {
        mcpUrl = undefined
      }
    }

    const basePrompt = createTaskMode
      ? buildConversationSystemPrompt('CodeTask Conversation', {
          mode: 'create_task',
          mcpToolsAvailable: Boolean(mcpUrl)
        })
      : ''
    const phasePrompt = wizardStage ? buildWizardPhasePromptSection(wizardStage) : ''
    const systemPromptBase =
      turnRole === 'draft' ? buildDraftTurnSystemPrompt(basePrompt) : basePrompt
    const baseSystemPrompt = createTaskMode
      ? phasePrompt
        ? `${systemPromptBase}\n\n${phasePrompt}`
        : systemPromptBase
      : buildConversationSystemPrompt('CodeTask Conversation', {
          mode: 'chat',
          mcpToolsAvailable: false
        })
    const systemPrompt = prepared.changeSetId
      ? `${baseSystemPrompt}\n\nYou are working in an isolated Change Set worktree. Implement the requested code changes directly in this worktree and verify them when practical. Do not attempt to write the user's main checkout; application is a separate explicit step.`
      : baseSystemPrompt

    let draftRevision: number | null = null
    let planRevision: number | null = null
    if (createTaskMode && thread.activeDraftId) {
      const draftMessage = await getMessage(username, thread.id, thread.activeDraftId, {
        signAssets: false
      })
      const payload = draftMessage?.payload as TaskLaunchDraftPayload | undefined
      draftRevision = payload?.revision ?? null
    }
    if (createTaskMode && thread.activePlanId) {
      const sessionRow = await getDesignSessionRow(thread.activePlanId)
      planRevision = sessionRow?.planRevision ?? null
    }
    const contextSnapshot = wizardStage
      ? buildWizardContextSnapshot({
          wizardPhase: wizardStage,
          activeDraftId: thread.activeDraftId,
          activePlanId: thread.activePlanId,
          draftRevision,
          planRevision,
          designSessionId: thread.activePlanId ?? null,
          selectedDraftSection: options?.selectedDraftSection?.trim() || null,
          selectedPlanNodeRef: options?.selectedPlanNodeRef?.trim() || null
        })
      : ''

    const attachmentBlock = buildAttachmentReferenceMarkdown({
      threadId: thread.id,
      attachments: turnAttachments
    })
    const turnPromptBase =
      turnRole === 'draft'
        ? `The user wants to generate the task launch draft now. If the information is sufficient, you MUST call \`propose_task_draft\` in this turn — do not output plain text instead.\n\nCurrent request:\n${trimmed}`
        : trimmed
    const turnPromptWithAttachments = attachmentBlock
      ? `${turnPromptBase}\n\n${attachmentBlock}`
      : turnPromptBase

    const workspaceSnapshot =
      createTaskMode &&
      wizardStage === WIZARD_PHASE_COLLECT &&
      isFirstWizardPhaseTurn(priorMessages, {
        excludeMessageId: userMessage.id,
        wizardPhase: WIZARD_PHASE_COLLECT
      })
        ? buildWorkspaceSnapshot(workspacePath)
        : ''

    const turnContextSections = [
      contextSnapshot,
      workspaceSnapshot,
      turnPromptWithAttachments
    ].filter(Boolean)
    const turnPromptWithContext = turnContextSections.join('\n\n')

    const historyBlock = shouldSeedConversationHistory(
      phaseRuntimeId,
      thread.coreCode,
      priorMessages,
      {
        excludeMessageId: userMessage.id,
        wizardPhase: wizardStage ?? undefined,
        createTaskMode
      }
    )
      ? buildConversationHistoryBlock(priorMessages, {
          excludeMessageId: userMessage.id,
          wizardPhase: wizardStage ?? undefined,
          createTaskMode
        })
      : null
    const turnPrompt = augmentPromptWithHistory(turnPromptWithContext, historyBlock)

    const mcpToolNames =
      createTaskMode && wizardStage ? toolsForWizardPhase(wizardStage) : undefined
    const cursorRuntimeScope =
      core.code === 'cursorcli'
        ? prepared.changeSetId
          ? `change:${prepared.changeSetId}`
          : buildConversationCursorRuntimeScope(thread.id, conversationKind)
        : undefined

    const attachmentReadRoots = resolveTurnAttachmentReadRoots({
      threadId: thread.id,
      attachments: turnAttachments
    })

    let reply = ''
    let thinking = ''
    let thinkingStartedAt: number | null = null
    let runtimeSessionId = thread.runtimeSessionId
    const assistantMessageId = `msg-${randomUUID()}`

    yield { event: 'assistant_start', data: { messageId: assistantMessageId } }

    try {
      for await (const chunk of streamAgentTurn({
        role: 'conversation',
        provider: core.code as SupportedCoreCode,
        workspaceRoot: workspacePath,
        runtimeRoot,
        prompt: turnPrompt,
        runtimeSessionId: phaseRuntimeId,
        model,
        systemPrompt,
        mcpUrl,
        mcpToolNames,
        readRoots: attachmentReadRoots.length > 0 ? attachmentReadRoots : undefined,
        jobId: cursorRuntimeScope,
        signal: options?.signal,
        workspaceAccess: prepared.workspaceAccess
      })) {
        while (draftEvents.length > 0) {
          const draftEvent = draftEvents.shift()
          if (draftEvent) yield draftEvent
        }

        if (chunk.type === 'thinking_delta') {
          if (thinkingStartedAt == null) thinkingStartedAt = Date.now()
          const advanced = appendTextPiece(thinking, chunk.content, {
            maxChars: MAX_TURN_TEXT_CHARS
          })
          thinking = advanced.text
          if (advanced.delta) {
            yield { event: 'thinking_delta', data: { content: advanced.delta } }
          }
        } else if (chunk.type === 'delta') {
          const advanced = appendTextPiece(reply, chunk.content, { maxChars: MAX_TURN_TEXT_CHARS })
          reply = advanced.text
          if (advanced.delta) {
            yield { event: 'delta', data: { content: advanced.delta } }
          }
        } else if (chunk.type === 'error') {
          throw new Error(chunk.message)
        } else if (chunk.type === 'completed') {
          reply =
            chunk.reply.length > MAX_TURN_TEXT_CHARS
              ? chunk.reply.slice(0, MAX_TURN_TEXT_CHARS)
              : chunk.reply
          runtimeSessionId = chunk.runtimeSessionId
        }
      }

      while (draftEvents.length > 0) {
        const draftEvent = draftEvents.shift()
        if (draftEvent) yield draftEvent
      }
    } finally {
      if (mcpSessionId) {
        unregisterConversationMcpSession(mcpSessionId)
      }
    }

    const finalReply = reply
    const finalThinking = thinking.trim()
    const thinkingDurationMs =
      thinkingStartedAt != null && finalThinking ? Date.now() - thinkingStartedAt : undefined

    let assistantWizardPhase: WizardPhase | null = createTaskMode ? wizardPhase : null
    if (createTaskMode) {
      const latestRow = await getThreadRow(username, thread.id)
      if (latestRow) {
        assistantWizardPhase = resolveWizardPhase(latestRow)
      }
    }

    const assistantMessage = await insertMessage({
      id: assistantMessageId,
      threadId: thread.id,
      username,
      role: 'assistant',
      kind: 'text',
      content: finalReply,
      coreCode: thread.coreCode,
      conversationId: thread.conversationId,
      runtimeSessionId,
      wizardPhase: assistantWizardPhase,
      payload: buildMessageThinkingPayload(finalThinking, thinkingDurationMs)
    })

    reply = ''
    thinking = ''
    memoryDebug('conversation.turn.completed', {
      threadId: thread.id,
      messageId: assistantMessageId,
      replyChars: finalReply.length
    })

    yield { event: 'assistant_message', data: { message: assistantMessage } }

    const latestThread = await getThread(username, thread.id)
    if (latestThread) {
      thread = latestThread
    }

    thread = await updateThreadRuntime(
      username,
      thread.id,
      thread.coreCode,
      runtimeSessionId,
      RUNTIME_STATUS_IDLE,
      null
    )

    const updatedCore = await getAgentCore(thread.coreCode)
    yield {
      event: 'done',
      data: {
        thread,
        state: buildThreadState(thread, workspacePath, updatedCore, 0)
      }
    }
  } catch (error) {
    const errMessage = formatSdkTurnError(error)
    const turnError = toTurnErrorDto(error)
    try {
      const current = await getThread(username, threadId)
      if (current) {
        thread = await updateThreadRuntime(
          username,
          threadId,
          current.coreCode,
          current.runtimeSessionId,
          RUNTIME_STATUS_ERROR,
          errMessage
        )
      }
    } catch {
      // best-effort, ignore errors
    }
    yield { event: 'error', data: { message: errMessage, error: turnError } }
  } finally {
    const { releaseWorkspaceLeaseForOwner } =
      await import('../legacy-control-plane/workspace-lease-store')
    releaseWorkspaceLeaseForOwner('conversation', threadId)
    releaseThread(threadId)
  }
}

export async function reconcileThreadsForUser(
  username: string,
  rows: ThreadDto[]
): Promise<ThreadDto[]> {
  const reconciled: ThreadDto[] = []
  for (const row of rows) {
    reconciled.push(await reconcileStaleThreadRuntime(username, row, isThreadInflight))
  }
  return reconciled
}

export async function reconcileOnStartup(): Promise<void> {
  const { reconcileOrphanRunningThreadsOnStartup } = await import('../threads/service')
  await reconcileOrphanRunningThreadsOnStartup(isThreadInflight)
}

let startupReconciled = false
let startupReconcilePromise: Promise<void> | null = null

export async function reconcileOnStartupOnce(): Promise<void> {
  if (startupReconciled) return
  if (startupReconcilePromise) return startupReconcilePromise

  startupReconcilePromise = reconcileOnStartup()
    .then(() => {
      startupReconciled = true
    })
    .finally(() => {
      startupReconcilePromise = null
    })

  return startupReconcilePromise
}

export function resetConversationReconcileForTests(): void {
  startupReconciled = false
  startupReconcilePromise = null
}
