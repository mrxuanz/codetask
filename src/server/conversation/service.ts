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
import { isDesignSessionId } from '@shared/design-session'
import { getThreadPhaseRuntime, resolveWizardPhase } from '../wizard/phase'
import { WIZARD_PHASE_COLLECT } from '../wizard/types'
import { toolsForWizardPhase } from '../wizard/tools'
import type { WizardPhase } from '../wizard/types'
import { buildWorkspaceSnapshot } from './workspace-snapshot'
import type { TaskLaunchDraftPayload } from './draft/types'
import { ensureCollectingDraft } from './draft/collecting'
import { formatSdkTurnError, toTurnErrorDto } from '../agent-runtime/errors'
import { ensureRuntimeRoot, streamAgentTurn } from '../agent-runtime/runner'
import { appendTextPiece, MAX_TURN_TEXT_CHARS } from '../agent-runtime/delta-emit'
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
import { maybeSeedThreadTitleFromFirstMessage } from './thread-title'

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function initConversationService(_options: { dataDir: string }): void {
  getAppContext()
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

function reserveThread(thread: ThreadDto): void {
  const registry = getAppContext().runtimeRegistry
  if (registry.isThreadInflight(thread.id)) {
    throw AppError.badRequest('Thread is busy; wait for the reply to finish', 'thread.busy')
  }
  if (thread.runtimeStatus === RUNTIME_STATUS_RUNNING) {
    throw AppError.badRequest('Thread is busy; wait for the reply to finish', 'thread.busy')
  }
  registry.addInflightThread(thread.id)
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
  await closeConversationCursorRuntime(threadId).catch((error) => {
    console.warn('[conversation] failed to close cursor runtime on core switch', threadId, error)
  })
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
  }
): AsyncGenerator<ChatSseEvent> {
  const trimmed = message.trim()
  if (!trimmed) {
    throw AppError.badRequest('Message cannot be empty', 'message.empty')
  }

  const resolved = await loadThreadProject(username, threadId)
  let thread = resolved.thread
  const workspacePath = resolved.workspacePath
  const threadRow = await getThreadRow(username, threadId)
  if (!threadRow) throw AppError.notFound('Thread not found', 'thread.not_found')
  const threadKind = resolveThreadKind(threadRow)
  const createTaskMode = options?.createTaskMode === true
  if (createTaskMode && threadKind !== THREAD_KIND_CREATE_TASK) {
    throw AppError.badRequest(
      'Start a task conversation from the Create Task entry',
      'thread.kind_mismatch',
      { expected: 'create_task', actual: threadKind }
    )
  }
  if (!createTaskMode && threadKind === THREAD_KIND_CREATE_TASK) {
    throw AppError.badRequest(
      'This conversation belongs to a task creation flow; continue in Create Task',
      'thread.kind_mismatch',
      { expected: 'chat', actual: threadKind }
    )
  }
  const wizardPhase = resolveWizardPhase(threadRow)
  thread = await reconcileStaleThreadRuntime(username, thread, isThreadInflight)
  reserveThread(thread)

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
      wizardPhase: options?.createTaskMode ? wizardPhase : null
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

    const runtimeRoot = ensureRuntimeRoot(
      getAppContext().dataDir,
      thread.id,
      core.code as SupportedCoreCode
    )
    const model = resolveCoreModel(core.code as SupportedCoreCode)
    const turnRole: ConversationTurnRole = options?.generateDraft ? 'draft' : 'chat'
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
    const systemPrompt = createTaskMode
      ? phasePrompt
        ? `${systemPromptBase}\n\n${phasePrompt}`
        : systemPromptBase
      : buildConversationSystemPrompt('CodeTask Conversation', {
          mode: 'chat',
          mcpToolsAvailable: false
        })

    let draftRevision: number | null = null
    let planRevision: number | null = null
    if (createTaskMode && thread.activeDraftId) {
      const draftMessage = await getMessage(username, thread.id, thread.activeDraftId, {
        signAssets: false
      })
      const payload = draftMessage?.payload as TaskLaunchDraftPayload | undefined
      draftRevision = payload?.revision ?? null
    }
    if (createTaskMode && thread.activePlanId && isDesignSessionId(thread.activePlanId)) {
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
          designSessionId: isDesignSessionId(thread.activePlanId) ? thread.activePlanId : null,
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
        ? buildConversationCursorRuntimeScope(thread.id, createTaskMode ? 'create_task' : 'chat')
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
        jobId: cursorRuntimeScope
      })) {
        while (draftEvents.length > 0) {
          const draftEvent = draftEvents.shift()
          if (draftEvent) yield draftEvent
        }

        if (chunk.type === 'thinking_delta') {
          if (thinkingStartedAt == null) thinkingStartedAt = Date.now()
          const advanced = appendTextPiece(thinking, chunk.content, { maxChars: MAX_TURN_TEXT_CHARS })
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
      wizardPhase: createTaskMode ? wizardPhase : null,
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
export async function reconcileOnStartupOnce(): Promise<void> {
  if (startupReconciled) return
  startupReconciled = true
  await reconcileOnStartup()
}
