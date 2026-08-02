import type { RealtimeTopic } from '@codetask/contracts'
import type { openRealtimeStream } from '@codetask/server-core'

export type RealtimeStreamHandle = ReturnType<typeof openRealtimeStream>

/** actorId::sessionId::connectionId → stream handle */
const activeHandles = new Map<string, RealtimeStreamHandle>()
const pendingTopics = new Map<string, RealtimeTopic[]>()

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
  activeHandles.set(key, handle)
  return key
}

export function getRealtimeHandle(key: string): RealtimeStreamHandle | undefined {
  return activeHandles.get(key)
}

export function takePendingTopics(key: string): RealtimeTopic[] | undefined {
  const queued = pendingTopics.get(key)
  if (queued === undefined) return undefined
  pendingTopics.delete(key)
  return queued
}

export function queuePendingTopics(key: string, topics: RealtimeTopic[]): void {
  pendingTopics.set(key, topics)
}

export function activeRealtimeKeys(): IterableIterator<string> {
  return activeHandles.keys()
}

export function unbindRealtimeHandle(key: string): void {
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
