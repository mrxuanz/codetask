// Bounded buffer with configurable overflow policy.
//
// `drop-oldest` is a generic bounded queue — when at capacity it evicts the
// first non-protected element from the front. If every element is protected it
// drops the head as a fallback, so the buffer never exceeds `max`.
//
// This differs from `event-bus.ts:trimJobSseQueue` which skips eviction when
// every element is protected and allows the queue to grow past its limit.
// The two implementations are intentionally separate; if event-bus ever reuses
// this module, a deliberate choice should be made about whether to adopt the
// "never exceed max" semantics or keep the existing "allow overflow" behaviour.
//
// `close` is designed for request-response transports (e.g. MCP SSE). Overflow
// means the consumer cannot keep up; instead of silently dropping events the
// buffer signals `overflow` so the transport can tear down the stream. Callers
// that push into the buffer are responsible for acting on `overflow`.
//
// Only `close` is wired in this PR. `drop-oldest` is provided for completeness
// but has no in-tree caller yet.

export type OverflowPolicy = 'drop-oldest' | 'close'

export type PushResult = 'ok' | 'dropped' | 'overflow'

export interface BoundedBuffer<T> {
  push: (value: T) => PushResult
  shift: () => T | undefined
  size: () => number
  toArray: () => T[]
}

export function createBoundedBuffer<T>(opts: {
  max: number
  policy: OverflowPolicy
  isProtected?: (value: T) => boolean
}): BoundedBuffer<T> {
  const items: T[] = []
  const { max, policy, isProtected } = opts

  function findDropIndex(): number {
    if (isProtected) {
      for (let i = 0; i < items.length; i++) {
        if (!isProtected(items[i])) return i
      }
    }
    return 0
  }

  return {
    push(value: T): PushResult {
      if (items.length < max) {
        items.push(value)
        return 'ok'
      }

      if (policy === 'close') {
        return 'overflow'
      }

      const dropIndex = findDropIndex()
      items.splice(dropIndex, 1)
      items.push(value)
      return 'dropped'
    },

    shift(): T | undefined {
      return items.shift()
    },

    size(): number {
      return items.length
    },

    toArray(): T[] {
      return [...items]
    }
  }
}
