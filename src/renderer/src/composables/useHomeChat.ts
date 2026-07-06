import { onMounted, ref, type InjectionKey, type Ref } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  fetchConversationCores,
  fetchThreadConversationState,
  fetchThreadMessages,
  streamThreadMessage,
  type ConversationCore,
  type ConversationMessage,
  type ConversationState
} from '@renderer/api/conversation'
import { uploadThreadAttachment } from '@renderer/api/jobs'
import type { ThreadJobDto } from '@shared/contracts/jobs'
import type { Thread } from '@renderer/api/threads'
import { updateThreadCore } from '@renderer/api/threads'
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

export function useHomeChat(
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
  let openToken = 0

  function clear(): void {
    openToken += 1
    messages.value = []
    activeThreadId.value = null
    activeCoreCode.value = null
    runtimeStatus.value = 'idle'
    streamingMessageId.value = null
    awaitingAssistantReply.value = false
    error.value = null
    loading.value = false
  }

  function clearStreamingMessage(): void {
    if (!streamingMessageId.value) return
    messages.value = removeStreamingAssistantMessage(messages.value, streamingMessageId.value)
    streamingMessageId.value = null
  }

  function displayError(value: TurnErrorDto | string | null | undefined): string | null {
    return formatTurnError(value, t)
  }

  function applyStatus(state: ConversationState): void {
    runtimeStatus.value = state.runtimeStatus ?? 'idle'
    activeCoreCode.value = state.core?.code ?? activeCoreCode.value
    error.value = displayError(state.lastError)
    if (state.runtimeStatus !== 'running') {
      clearStreamingMessage()
    }
  }

  async function openThread(thread: Thread): Promise<void> {
    const token = ++openToken
    activeThreadId.value = thread.id
    activeCoreCode.value = thread.coreCode
    runtimeStatus.value = thread.runtimeStatus || 'idle'
    streamingMessageId.value = null
    messages.value = []
    loading.value = true
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
        const attachment = await uploadThreadAttachment(threadId, file)
        attachmentIds.push(attachment.id)
      }

      await streamThreadMessage(
        threadId,
        outbound,
        (event) => {
          switch (event.event) {
            case 'user_message':
              messages.value = replaceOptimisticUserMessage(
                messages.value,
                optimisticUserId,
                event.data.message
              )
              optimisticUserId = null
              break
            case 'draft_message': {
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
              if (!activeStreamingId) break
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
              if (!activeStreamingId) break
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
              messages.value = finalizeStreamingAssistantMessage(messages.value, event.data.message)
              activeStreamingId = null
              streamingMessageId.value = null
              awaitingAssistantReply.value = false
              break
            case 'done':
              applyStatus(event.data.state)
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
            case 'error':
              clearStreamingMessage()
              activeStreamingId = null
              awaitingAssistantReply.value = false
              runtimeStatus.value = 'error'
              error.value = displayError(event.data.error ?? event.data.message)
              patchThreadRuntime(threadId, {
                coreCode: activeCoreCode.value ?? 'codex',
                runtimeStatus: 'error',
                runtimeSessionId: null,
                lastError: coerceTurnErrorField(event.data.error ?? event.data.message),
                lastUsedAt: Math.floor(Date.now() / 1000),
                updatedAt: Math.floor(Date.now() / 1000)
              })
              break
          }
        },
        { generateDraft, createTaskMode: input.createTaskMode === true, attachmentIds }
      )
      return resultThread
    } catch (err) {
      clearStreamingMessage()
      awaitingAssistantReply.value = false
      runtimeStatus.value = 'error'
      error.value = err instanceof Error ? err.message : t('workspace.sendFailed')
      return null
    } finally {
      sending.value = false
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
    loadCores,
    openThread,
    setCoreCode,
    sendMessage,
    updateDraftMessage,
    clear
  }
}
