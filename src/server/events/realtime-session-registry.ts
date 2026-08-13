import type { RealtimeTopic } from '@codetask/contracts'
import type { openRealtimeStream } from '@codetask/server-core'

export type RealtimeStreamHandle = ReturnType<typeof openRealtimeStream>

/** actorId::sessionId::connectionId → stream handle */
const activeHandles = new Map<string, RealtimeStreamHandle>()
const PENDING_TOPICS_TTL_MS = 60_000
const MAX_PENDING_TOPIC_SETS = 256
const pendingTopics = new Map<
  string,
  { topics: RealtimeTopic[]; expiresAt: number; queuedAt: number }
>()

function prunePendingTopics(now = Date.now()): void {
  for (const [key, value] of pendingTopics) {
    if (value.expiresAt <= now) pendingTopics.delete(key)
  }
}

export function realtimeKey(actorId: string, sessionId: string, connectionId: string): string {
  return `${actorId}::${sessionId}::${connectionId}`
}

export function bindRealtimeHandle(
  actorId: string,
  sessionId: string,
  connectionId: string,
  handle: RealtimeStreamHandle
): string {
  const key = realtimeKey(actorId, sessionId, connectionId)
  const previous = activeHandles.get(key)
  if (previous && previous !== handle) previous.close()
  activeHandles.set(key, handle)
  return key
}

export function getRealtimeHandle(key: string): RealtimeStreamHandle | undefined {
  return activeHandles.get(key)
}

export function takePendingTopics(key: string): RealtimeTopic[] | undefined {
  prunePendingTopics()
  const queued = pendingTopics.get(key)
  if (queued === undefined) return undefined
  pendingTopics.delete(key)
  return queued.topics
}

export function queuePendingTopics(key: string, topics: RealtimeTopic[]): void {
  const now = Date.now()
  prunePendingTopics(now)
  if (!pendingTopics.has(key) && pendingTopics.size >= MAX_PENDING_TOPIC_SETS) {
    let oldestKey: string | undefined
    let oldestAt = Number.POSITIVE_INFINITY
    for (const [candidateKey, value] of pendingTopics) {
      if (value.queuedAt < oldestAt) {
        oldestAt = value.queuedAt
        oldestKey = candidateKey
      }
    }
    if (oldestKey) pendingTopics.delete(oldestKey)
  }
  pendingTopics.set(key, {
    topics: [...topics],
    queuedAt: now,
    expiresAt: now + PENDING_TOPICS_TTL_MS
  })
}

export function activeRealtimeKeys(): IterableIterator<string> {
  return activeHandles.keys()
}

export function unbindRealtimeHandle(key: string, expected?: RealtimeStreamHandle): void {
  if (expected && activeHandles.get(key) !== expected) return
  activeHandles.delete(key)
  pendingTopics.delete(key)
}

export function closeRealtimeForSession(actorId: string, sessionId: string): void {
  const needle = `${actorId}::${sessionId}::`
  for (const [key, handle] of activeHandles) {
    if (key.startsWith(needle)) {
      handle.close()
      activeHandles.delete(key)
      pendingTopics.delete(key)
    }
  }
}

export function closeRealtimeForUser(actorId: string): void {
  const prefix = `${actorId}::`
  for (const [key, handle] of [...activeHandles.entries()]) {
    if (key.startsWith(prefix)) {
      handle.close()
      activeHandles.delete(key)
      pendingTopics.delete(key)
    }
  }
}

export function resetRealtimeSessionRegistryForTests(): void {
  for (const handle of activeHandles.values()) {
    try {
      handle.close()
    } catch {
      /* ignore */
    }
  }
  activeHandles.clear()
  pendingTopics.clear()
}
