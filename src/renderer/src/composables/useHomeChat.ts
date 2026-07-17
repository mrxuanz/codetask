import { onMounted, ref, type InjectionKey, type Ref } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  createThreadTurn,
  fetchConversationCores,
  fetchThreadConversationState,
  fetchThreadMessages,
  type ConversationCore,
  type ConversationMessage,
  type ConversationState
} from '@renderer/api/conversation'
import { uploadThreadAttachment } from '@renderer/api/jobs'
import type { ThreadJobDto } from '@shared/contracts/jobs'
import type { ChatSseEvent, ConversationTurnStatus } from '@shared/contracts'
import { turnTopic } from '@shared/contracts/job-event-hub'
import type { Thread } from '@renderer/api/threads'
import { updateThreadCore } from '@renderer/api/threads'
import type { JobEventHub } from '@renderer/composables/useJobEventHub'
import {
  finalizeStreamingAssistantMessage,
  removeStreamingAssistantMessage,
  replaceOptimisticUserMessage,
  upsertStreamingAssistantMessage
} from '@renderer/lib/conversationMessages'
import { setPreferredCoreCode } from '@renderer/lib/preferredCore'
import { formatTurnError } from '@renderer/i18n/formatTurnError'
import type { TurnErrorDto } from '@shared/turn-errors'
import { coerceTurnErrorField } from '@shared/turn-errors'
import type { WorkspaceAccessMode } from '@shared/workspace-access'

export interface HomeChatContext {
  cores: Ref<ConversationCore[]>
  messages: Ref<ConversationMessage[]>
  activeThreadId: Ref<string | null>
  activeCoreCode: Ref<string | null>
  runtimeStatus: Ref<string>
  streamingMessageId: Ref<string | null>
  awaitingAssistantReply: Ref<boolean>
  loading: Ref<boolean>
  coreSwitching: Ref<boolean>
  sending: Ref<boolean>
  error: Ref<string | null>
  activeWorkspaceAccess: Ref<WorkspaceAccessMode | null>
  loadCores: () => Promise<void>
  openThread: (thread: Thread) => Promise<void>
  setCoreCode: (threadId: string, coreCode: string) => Promise<Thread | null>
  sendMessage: (input: {
    message: string
    files?: File[]
    generateDraft?: boolean
    createTaskMode?: boolean
    onPlanUpdated?: (job: ThreadJobDto) => void
  }) => Promise<Thread | null>
  updateDraftMessage: (message: ConversationMessage) => void
  clear: () => void
}

export const HomeChatKey: InjectionKey<HomeChatContext> = Symbol('homeChat')

function isAbortError(err: unknown): boolean {
  return (
    (err instanceof DOMException && err.name === 'AbortError') ||
    (err instanceof Error && err.name === 'AbortError')
  )
}

function isTerminalTurnStatus(status: ConversationTurnStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
}

export function useHomeChat(
  hub: JobEventHub,
  syncThread: (thread: Thread) => void,
  patchThreadRuntime: (
    threadId: string,
    patch: Pick<
      Thread,
      'runtimeStatus' | 'runtimeSessionId' | 'lastError' | 'lastUsedAt' | 'coreCode' | 'updatedAt'
    >
  ) => void
): HomeChatContext {
  const { t } = useI18n()
  const cores = ref<ConversationCore[]>([])
  const messages = ref<ConversationMessage[]>([])
  const activeThreadId = ref<string | null>(null)
  const activeCoreCode = ref<string | null>(null)
  const runtimeStatus = ref('idle')
  const streamingMessageId = ref<string | null>(null)
  const awaitingAssistantReply = ref(false)
  const loading = ref(false)
  const coreSwitching = ref(false)
  const sending = ref(false)
  const error = ref<string | null>(null)
  const activeWorkspaceAccess = ref<WorkspaceAccessMode | null>(null)
  let openToken = 0
  let turnUnsub: (() => void) | null = null
  let settleActiveTurn: ((err?: unknown) => void) | null = null
  let streamGeneration = 0

  /** Detach UI from an in-flight turn. Does NOT cancel the server turn. */
  function detachActiveTurn(reason?: unknown): void {
    turnUnsub?.()
    turnUnsub = null
    const settle = settleActiveTurn
    settleActiveTurn = null
    if (settle) {
      settle(reason ?? new DOMException('The operation was aborted.', 'AbortError'))
    }
  }

  function isViewingThread(threadId: string): boolean {
    return activeThreadId.value === threadId
  }

  function clear(): void {
    openToken += 1
    detachActiveTurn()
    messages.value = []
    activeThreadId.value = null
    activeCoreCode.value = null
    runtimeStatus.value = 'idle'
    activeWorkspaceAccess.value = null
    streamingMessageId.value = null
    awaitingAssistantReply.value = false
    sending.value = false
    error.value = null
    loading.value = false
  }

  function clearStreamingMessage(options?: { removePlaceholder?: boolean }): void {
    const messageId = streamingMessageId.value
    streamingMessageId.value = null
    if (!messageId || options?.removePlaceholder === false) return
    const existing = messages.value.find((message) => message.id === messageId)
    // Only drop empty in-flight placeholders; keep streamed content if finalize never arrived.
    if (existing && !existing.content.trim() && !existing.thinking?.trim()) {
      messages.value = removeStreamingAssistantMessage(messages.value, messageId)
    }
  }

  function displayError(value: TurnErrorDto | string | null | undefined): string | null {
    return formatTurnError(value, t)
  }

  function applyStatus(state: ConversationState): void {
    runtimeStatus.value = state.runtimeStatus ?? 'idle'
    activeCoreCode.value = state.core?.code ?? activeCoreCode.value
    error.value = displayError(state.lastError)
    if (state.runtimeStatus !== 'running') {
      // done/idle: stop streaming cursor without wiping the finalized assistant message
      clearStreamingMessage({ removePlaceholder: false })
    }
  }

  async function openThread(thread: Thread): Promise<void> {
    const sameThread = activeThreadId.value === thread.id
    const token = ++openToken
    if (!sameThread) {
      // Detach UI from previous turn; server turn keeps running.
      detachActiveTurn()
      awaitingAssistantReply.value = false
      sending.value = false
      messages.value = []
      loading.value = true
    }
    activeThreadId.value = thread.id
    activeCoreCode.value = thread.coreCode
    runtimeStatus.value = thread.runtimeStatus || 'idle'
    streamingMessageId.value = null
    error.value = displayError(thread.lastError)

    try {
      const [stateRes, historyRes] = await Promise.all([
        fetchThreadConversationState(thread.id),
        fetchThreadMessages(thread.id, 100)
      ])
      if (token !== openToken || activeThreadId.value !== thread.id) return
      messages.value = historyRes.data.messages ?? []
      applyStatus(stateRes.data)
      activeCoreCode.value = stateRes.data.core?.code ?? thread.coreCode
    } catch (err) {
      if (token !== openToken || activeThreadId.value !== thread.id) return
      error.value = err instanceof Error ? err.message : t('workspace.loadThreadFailed')
    } finally {
      if (token === openToken) {
        loading.value = false
      }
    }
  }

  async function loadCores(): Promise<void> {
    try {
      const res = await fetchConversationCores()
      cores.value = res.data.cores ?? []
    } catch {
      cores.value = []
    }
  }

  async function setCoreCode(threadId: string, coreCode: string): Promise<Thread | null> {
    coreSwitching.value = true
    error.value = null
    try {
      const res = await updateThreadCore(threadId, coreCode)
      const thread = res.data
      setPreferredCoreCode(thread.coreCode)
      if (activeThreadId.value === threadId) {
        activeCoreCode.value = thread.coreCode
        runtimeStatus.value = thread.runtimeStatus
        error.value = displayError(thread.lastError)
      }
      return thread
    } catch (err) {
      error.value = err instanceof Error ? err.message : t('workspace.switchCoreFailed')
      return null
    } finally {
      coreSwitching.value = false
    }
  }

  function updateDraftMessage(message: ConversationMessage): void {
    messages.value = messages.value.map((item) => (item.id === message.id ? message : item))
  }

  async function sendMessage(input: {
    message: string
    files?: File[]
    generateDraft?: boolean
    createTaskMode?: boolean
    onPlanUpdated?: (job: ThreadJobDto) => void
  }): Promise<Thread | null> {
    const threadId = activeThreadId.value
    if (!threadId) return null

    const generateDraft = input.generateDraft === true
    const outbound = input.message.trim()
    if (!outbound && !(input.files?.length ?? 0)) return null

    detachActiveTurn()
    const generation = ++streamGeneration

    sending.value = true
    runtimeStatus.value = 'running'
    awaitingAssistantReply.value = true
    error.value = null

    let resultThread: Thread | null = null
    const coreCode = activeCoreCode.value ?? 'codex'
    let activeStreamingId: string | null = null
    let optimisticUserId: string | null = null
    let activeThinking = ''

    if (outbound) {
      optimisticUserId = `optimistic-user-${Date.now()}`
      messages.value = [
        ...messages.value,
        {
          id: optimisticUserId,
          role: 'user',
          kind: 'text',
          content: outbound,
          attachments: [],
          coreCode,
          createdAt: new Date().toISOString()
        }
      ]
    }

    try {
      const attachmentIds: string[] = []
      for (const file of input.files ?? []) {
        if (!isViewingThread(threadId) || generation !== streamGeneration) {
          throw new DOMException('The operation was aborted.', 'AbortError')
        }
        const attachment = await uploadThreadAttachment(threadId, file)
        attachmentIds.push(attachment.id)
      }

      const accepted = await createThreadTurn(threadId, outbound, {
        generateDraft,
        createTaskMode: input.createTaskMode === true,
        attachmentIds
      })
      const turnId = accepted.data.turnId

      await new Promise<void>((resolve, reject) => {
        let settled = false
        const finish = (err?: unknown): void => {
          if (settled) return
          settled = true
          settleActiveTurn = null
          turnUnsub?.()
          turnUnsub = null
          if (err) reject(err)
          else resolve()
        }
        settleActiveTurn = finish

        turnUnsub = hub.watchTopic(turnTopic(turnId), (envelope) => {
          if (generation !== streamGeneration) return

          if (envelope.event === 'turn_snapshot') {
            const snapshotAccess = envelope.data.turn.workspaceAccess
            activeWorkspaceAccess.value =
              !isTerminalTurnStatus(envelope.data.turn.status) &&
              (snapshotAccess === 'exclusive-write' || snapshotAccess === 'live-read')
                ? snapshotAccess
                : null
            if (isTerminalTurnStatus(envelope.data.turn.status)) {
              const terminalTurn = envelope.data.turn
              // POST may finish before the topic subscription is installed, and reconnect may
              // legitimately resync with only a terminal snapshot. Re-read durable messages/state
              // so the final answer never depends on receiving every streaming delta.
              void Promise.all([
                fetchThreadMessages(threadId, 100),
                fetchThreadConversationState(threadId)
              ])
                .then(([historyRes, stateRes]) => {
                  if (generation !== streamGeneration || !isViewingThread(threadId)) return
                  messages.value = historyRes.data.messages ?? []
                  activeStreamingId = null
                  streamingMessageId.value = null
                  awaitingAssistantReply.value = false
                  applyStatus(stateRes.data)
                  if (terminalTurn.status === 'failed') {
                    runtimeStatus.value = 'error'
                    error.value = displayError(terminalTurn.lastError)
                  } else if (terminalTurn.status === 'cancelled') {
                    runtimeStatus.value = 'idle'
                  }
                })
                .catch((syncError) => {
                  if (generation !== streamGeneration || !isViewingThread(threadId)) return
                  clearStreamingMessage()
                  activeStreamingId = null
                  awaitingAssistantReply.value = false
                  if (terminalTurn.status === 'failed') {
                    runtimeStatus.value = 'error'
                    error.value = displayError(terminalTurn.lastError)
                  } else {
                    error.value = syncError instanceof Error ? syncError.message : null
                  }
                })
              finish()
            }
            return
          }

          const event = envelope as ChatSseEvent
          const viewing = isViewingThread(threadId)

          switch (event.event) {
            case 'user_message':
              if (!viewing) break
              messages.value = replaceOptimisticUserMessage(
                messages.value,
                optimisticUserId,
                event.data.message
              )
              optimisticUserId = null
              break
            case 'draft_message': {
              if (!viewing) break
              const draftMessage = event.data.message
              const exists = messages.value.some((m) => m.id === draftMessage.id)
              messages.value = exists
                ? messages.value.map((m) => (m.id === draftMessage.id ? draftMessage : m))
                : [...messages.value, draftMessage]
              break
            }
            case 'plan_updated':
              input.onPlanUpdated?.(event.data.job)
              break
            case 'assistant_start':
              if (!viewing) break
              activeStreamingId = event.data.messageId
              activeThinking = ''
              streamingMessageId.value = event.data.messageId
              messages.value = upsertStreamingAssistantMessage(
                messages.value,
                event.data.messageId,
                '',
                coreCode,
                ''
              )
              break
            case 'thinking_delta':
              if (!viewing || !activeStreamingId) break
              activeThinking += event.data.content
              messages.value = upsertStreamingAssistantMessage(
                messages.value,
                activeStreamingId,
                messages.value.find((m) => m.id === activeStreamingId)?.content ?? '',
                coreCode,
                activeThinking
              )
              break
            case 'delta':
              if (!viewing || !activeStreamingId) break
              {
                const current =
                  messages.value.find((m) => m.id === activeStreamingId)?.content ?? ''
                messages.value = upsertStreamingAssistantMessage(
                  messages.value,
                  activeStreamingId,
                  current + event.data.content,
                  coreCode,
                  activeThinking
                )
              }
              break
            case 'assistant_message':
              if (!viewing) break
              messages.value = finalizeStreamingAssistantMessage(messages.value, event.data.message)
              activeStreamingId = null
              streamingMessageId.value = null
              awaitingAssistantReply.value = false
              break
            case 'done':
              syncThread(event.data.thread)
              patchThreadRuntime(event.data.thread.id, {
                coreCode: event.data.thread.coreCode,
                runtimeStatus: event.data.thread.runtimeStatus,
                runtimeSessionId: event.data.thread.runtimeSessionId,
                lastError: event.data.thread.lastError,
                lastUsedAt: event.data.thread.lastUsedAt,
                updatedAt: event.data.thread.updatedAt
              })
              resultThread = event.data.thread
              if (viewing) {
                applyStatus(event.data.state)
              }
              break
            case 'thread_updated':
              syncThread(event.data.thread)
              patchThreadRuntime(event.data.thread.id, {
                coreCode: event.data.thread.coreCode,
                runtimeStatus: event.data.thread.runtimeStatus,
                runtimeSessionId: event.data.thread.runtimeSessionId,
                lastError: event.data.thread.lastError,
                lastUsedAt: event.data.thread.lastUsedAt,
                updatedAt: event.data.thread.updatedAt
              })
              if (resultThread?.id === event.data.thread.id) {
                resultThread = event.data.thread
              }
              break
            case 'heartbeat':
              break
            case 'error':
              patchThreadRuntime(threadId, {
                coreCode: coreCode,
                runtimeStatus: 'error',
                runtimeSessionId: null,
                lastError: coerceTurnErrorField(event.data.error ?? event.data.message),
                lastUsedAt: Math.floor(Date.now() / 1000),
                updatedAt: Math.floor(Date.now() / 1000)
              })
              if (viewing) {
                clearStreamingMessage()
                activeStreamingId = null
                awaitingAssistantReply.value = false
                runtimeStatus.value = 'error'
                error.value = displayError(event.data.error ?? event.data.message)
              }
              break
          }
        })

        void hub.flushSubscriptionsNow()
      })

      return resultThread
    } catch (err) {
      if (isAbortError(err)) {
        return null
      }
      if (generation === streamGeneration && isViewingThread(threadId)) {
        clearStreamingMessage()
        awaitingAssistantReply.value = false
        runtimeStatus.value = 'error'
        error.value = err instanceof Error ? err.message : t('workspace.sendFailed')
      }
      return null
    } finally {
      if (generation === streamGeneration && isViewingThread(threadId)) {
        sending.value = false
      }
    }
  }

  onMounted(() => {
    void loadCores()
  })

  return {
    cores,
    messages,
    activeThreadId,
    activeCoreCode,
    runtimeStatus,
    streamingMessageId,
    awaitingAssistantReply,
    loading,
    coreSwitching,
    sending,
    error,
    activeWorkspaceAccess,
    loadCores,
    openThread,
    setCoreCode,
    sendMessage,
    updateDraftMessage,
    clear
  }
}
