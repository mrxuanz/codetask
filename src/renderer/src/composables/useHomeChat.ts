import { onMounted, ref, type InjectionKey, type Ref } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  createConversationTurn,
  fetchConversationCores,
  fetchThreadConversationState,
  fetchConversationMessages,
  type ConversationCore,
  type ConversationMessage,
  type ConversationState
} from '@renderer/api/conversation'
import { uploadThreadAttachment } from '@renderer/api/jobs'
import { conversationTopic, conversationTurnTopic } from '@codetask/contracts'
import type { ConversationTurnDto } from '@codetask/contracts'
import type { Thread } from '@renderer/api/threads'
import { threadFromConversationPayload, updateThreadCore } from '@renderer/api/threads'
import type { RealtimeGateway } from '@renderer/composables/useRealtimeGateway'
import { realtimePayload } from '@renderer/composables/useRealtimeGateway'
import {
  finalizeStreamingAssistantMessage,
  removeStreamingAssistantMessage,
  replaceOptimisticUserMessage,
  upsertStreamingAssistantMessage
} from '@renderer/lib/conversationMessages'
import { setPreferredCoreCode } from '@renderer/lib/preferredCore'
import { formatTurnError } from '@renderer/i18n/formatTurnError'
import type { TurnErrorDto } from '@shared/turn-errors'
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

function isTerminalTurnStatus(status: string): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
}

function readTurnPayload(value: unknown): ConversationTurnDto | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const turn = value as Partial<ConversationTurnDto>
  if (typeof turn.id !== 'string' || typeof turn.state !== 'string') return null
  if (typeof turn.workspaceAccess !== 'string') return null
  return turn as ConversationTurnDto
}

function readMessagePayload(value: unknown): ConversationMessage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const message = value as Partial<ConversationMessage>
  if (typeof message.id !== 'string' || typeof message.role !== 'string') return null
  if (typeof message.content !== 'string') return null
  return message as ConversationMessage
}

export function useHomeChat(
  hub: RealtimeGateway,
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
      activeWorkspaceAccess.value = null
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
        fetchConversationMessages(thread.id, 100)
      ])
      if (token !== openToken || activeThreadId.value !== thread.id) return
      messages.value = historyRes.data ?? []
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
  }): Promise<Thread | null> {
    const threadId = activeThreadId.value
    if (!threadId) return null

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

      const accepted = await createConversationTurn(threadId, outbound, {
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

        const releases: Array<() => void> = []
        const onEnvelope = (envelope: import('@codetask/contracts').RealtimeEnvelope): void => {
          if (generation !== streamGeneration) return

          // Terminal durable turn events → HTTP resync
          if (
            envelope.type === 'turn.changed' ||
            envelope.type === 'turn.completed' ||
            envelope.type === 'turn.failed' ||
            envelope.type === 'turn.cancelled'
          ) {
            const data = realtimePayload(envelope)
            const turn = readTurnPayload(data.turn)
            if (!turn) return
            const status = turn.state
            const snapshotAccess = turn.workspaceAccess
            activeWorkspaceAccess.value =
              !isTerminalTurnStatus(status) &&
              (snapshotAccess === 'exclusive-write' || snapshotAccess === 'live-read')
                ? snapshotAccess
                : null
            if (isTerminalTurnStatus(status)) {
              const terminalTurn = turn
              void Promise.all([
                fetchConversationMessages(threadId, 100),
                fetchThreadConversationState(threadId)
              ])
                .then(([historyRes, stateRes]) => {
                  if (generation !== streamGeneration || !isViewingThread(threadId)) return
                  messages.value = historyRes.data ?? []
                  activeStreamingId = null
                  streamingMessageId.value = null
                  awaitingAssistantReply.value = false
                  applyStatus(stateRes.data)
                  if (status === 'failed' || envelope.type === 'turn.failed') {
                    runtimeStatus.value = 'error'
                    error.value = displayError(terminalTurn.lastError)
                  } else if (status === 'cancelled' || envelope.type === 'turn.cancelled') {
                    runtimeStatus.value = 'idle'
                  }
                })
                .catch((syncError) => {
                  if (generation !== streamGeneration || !isViewingThread(threadId)) return
                  clearStreamingMessage()
                  activeStreamingId = null
                  awaitingAssistantReply.value = false
                  if (status === 'failed' || envelope.type === 'turn.failed') {
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

          const viewing = isViewingThread(threadId)
          const data = realtimePayload(envelope)

          switch (envelope.type) {
            case 'message.committed':
              if (!viewing) break
              {
                const message = readMessagePayload(data.message)
                if (!message) break
                if (message.role === 'user') {
                  messages.value = replaceOptimisticUserMessage(
                    messages.value,
                    optimisticUserId,
                    message
                  )
                  optimisticUserId = null
                } else if (message.role === 'assistant') {
                  messages.value = finalizeStreamingAssistantMessage(messages.value, message)
                  activeStreamingId = null
                  streamingMessageId.value = null
                  awaitingAssistantReply.value = false
                }
              }
              break
            case 'assistant.thinking.delta':
              if (!viewing) break
              {
                const content = String(data.content ?? '')
                if (!activeStreamingId) {
                  activeStreamingId = `stream-${turnId}`
                  streamingMessageId.value = activeStreamingId
                }
                activeThinking += content
                messages.value = upsertStreamingAssistantMessage(
                  messages.value,
                  activeStreamingId,
                  messages.value.find((m) => m.id === activeStreamingId)?.content ?? '',
                  coreCode,
                  activeThinking
                )
              }
              break
            case 'assistant.text.delta':
              if (!viewing) break
              {
                const content = String(data.content ?? '')
                if (!activeStreamingId) {
                  activeStreamingId = `stream-${turnId}`
                  streamingMessageId.value = activeStreamingId
                }
                const current =
                  messages.value.find((m) => m.id === activeStreamingId)?.content ?? ''
                messages.value = upsertStreamingAssistantMessage(
                  messages.value,
                  activeStreamingId,
                  current + content,
                  coreCode,
                  activeThinking
                )
              }
              break
            case 'conversation.changed': {
              const thread = threadFromConversationPayload(data.conversation)
              if (!thread) break
              syncThread(thread)
              patchThreadRuntime(thread.id, {
                coreCode: thread.coreCode,
                runtimeStatus: thread.runtimeStatus,
                runtimeSessionId: thread.runtimeSessionId,
                lastError: thread.lastError,
                lastUsedAt: thread.lastUsedAt,
                updatedAt: thread.updatedAt
              })
              resultThread = thread
              break
            }
          }
        }

        releases.push(hub.watchTopic(conversationTurnTopic(turnId), onEnvelope))
        releases.push(hub.watchTopic(conversationTopic(threadId), onEnvelope))
        turnUnsub = () => {
          for (const release of releases) release()
        }

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
