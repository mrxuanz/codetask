import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { UiConversationMessage } from '@codetask/contracts'
import {
  createConversationDeltaBuffer,
  type DeltaFlushScheduler
} from '../../apps/web/src/lib/conversationDeltaBuffer.ts'

function manualScheduler(): DeltaFlushScheduler & {
  pendingCount(): number
  runNext(): void
} {
  const callbacks = new Map<number, () => void>()
  let nextId = 0
  return {
    schedule(callback) {
      const id = ++nextId
      callbacks.set(id, callback)
      return id
    },
    cancel(handle) {
      callbacks.delete(handle as number)
    },
    pendingCount() {
      return callbacks.size
    },
    runNext() {
      const entry = callbacks.entries().next().value as [number, () => void] | undefined
      assert.ok(entry, 'expected a scheduled delta flush')
      callbacks.delete(entry[0])
      entry[1]()
    }
  }
}

describe('conversation delta buffer', () => {
  it('coalesces text and thinking deltas into one message update', () => {
    const scheduler = manualScheduler()
    let messages: UiConversationMessage[] = []
    const buffer = createConversationDeltaBuffer({
      providerCode: 'opencode',
      isCurrent: () => true,
      getStreamingMessageId: () => 'stream-1',
      getMessages: () => messages,
      updateMessages: (next) => {
        messages = next
      },
      scheduler
    })

    buffer.appendThinking('reason ')
    buffer.appendText('hello')
    buffer.appendThinking('step')

    assert.equal(scheduler.pendingCount(), 1)
    scheduler.runNext()
    assert.equal(messages[0]?.content, 'hello')
    assert.equal(messages[0]?.thinking, 'reason step')
    assert.equal(messages[0]?.providerCode, 'opencode')

    buffer.appendText(' world')
    scheduler.runNext()
    assert.equal(messages[0]?.content, 'hello world')
    assert.equal(messages[0]?.thinking, 'reason step')
  })

  it('drops stale deltas instead of leaking them into a later flush', () => {
    const scheduler = manualScheduler()
    let current = false
    let messages: UiConversationMessage[] = []
    const buffer = createConversationDeltaBuffer({
      providerCode: 'codex',
      isCurrent: () => current,
      getStreamingMessageId: () => 'stream-1',
      getMessages: () => messages,
      updateMessages: (next) => {
        messages = next
      },
      scheduler
    })

    buffer.appendText('stale')
    scheduler.runNext()
    current = true
    buffer.appendText('fresh')
    scheduler.runNext()

    assert.equal(messages[0]?.content, 'fresh')
  })

  it('cancels a scheduled update when the stream is cleared', () => {
    const scheduler = manualScheduler()
    const buffer = createConversationDeltaBuffer({
      providerCode: 'codex',
      isCurrent: () => true,
      getStreamingMessageId: () => 'stream-1',
      getMessages: () => [],
      updateMessages: () => undefined,
      scheduler
    })

    buffer.appendText('pending')
    buffer.clear()

    assert.equal(scheduler.pendingCount(), 0)
  })
})
