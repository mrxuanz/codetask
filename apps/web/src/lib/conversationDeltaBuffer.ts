import type { UiConversationMessage } from '@codetask/contracts'
import { upsertStreamingAssistantMessage } from './conversationMessages'

export interface DeltaFlushScheduler {
  schedule(callback: () => void): unknown
  cancel(handle: unknown): void
}

export interface ConversationDeltaBuffer {
  appendText(content: string): void
  appendThinking(content: string): void
  flush(): void
  clear(): void
}

const animationFrameScheduler: DeltaFlushScheduler = {
  schedule: (callback) => setTimeout(callback, 16),
  cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
}

/**
 * Batches fast realtime deltas into one immutable message-list update.
 * The caller owns stream identity and lifecycle; this helper only buffers text.
 */
export function createConversationDeltaBuffer(options: {
  providerCode: string
  isCurrent: () => boolean
  getStreamingMessageId: () => string | null
  getMessages: () => UiConversationMessage[]
  updateMessages: (messages: UiConversationMessage[]) => void
  scheduler?: DeltaFlushScheduler
}): ConversationDeltaBuffer {
  const scheduler = options.scheduler ?? animationFrameScheduler
  let scheduledFlush: unknown | null = null
  let pendingText = ''
  let pendingThinking = ''
  let accumulatedThinking = ''

  const discardPending = (): void => {
    pendingText = ''
    pendingThinking = ''
  }

  const flush = (): void => {
    scheduledFlush = null
    const streamingMessageId = options.getStreamingMessageId()
    if (!options.isCurrent() || !streamingMessageId) {
      discardPending()
      return
    }

    const messages = options.getMessages()
    const current = messages.find((message) => message.id === streamingMessageId)?.content ?? ''
    accumulatedThinking += pendingThinking
    options.updateMessages(
      upsertStreamingAssistantMessage(
        messages,
        streamingMessageId,
        current + pendingText,
        options.providerCode,
        accumulatedThinking
      )
    )
    discardPending()
  }

  const scheduleFlush = (): void => {
    if (scheduledFlush !== null) return
    scheduledFlush = scheduler.schedule(flush)
  }

  return {
    appendText(content) {
      pendingText += content
      scheduleFlush()
    },
    appendThinking(content) {
      pendingThinking += content
      scheduleFlush()
    },
    flush,
    clear() {
      if (scheduledFlush !== null) scheduler.cancel(scheduledFlush)
      scheduledFlush = null
      accumulatedThinking = ''
      discardPending()
    }
  }
}
