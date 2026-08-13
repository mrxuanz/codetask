import { inject, onScopeDispose, provide, ref, type InjectionKey, type Ref } from 'vue'
import { useDebounceFn } from '@vueuse/core'
import {
  jobTopic,
  parseRealtimeTopic,
  type RealtimeEnvelope,
  type RealtimeTopic
} from '@codetask/contracts'
import { connectRealtimeStream, putRealtimeSubscriptions } from '@renderer/api/realtime'
import { ApiError } from '@renderer/api/client'
import { handleUnauthorizedApiError } from '@renderer/auth/sessionRedirect'
import { RealtimeReducer } from '@renderer/realtime/reducer'

export type RealtimeListener = (envelope: RealtimeEnvelope) => void

export interface RealtimeGateway {
  connected: Ref<boolean>
  connectionId: string
  watchTopic: (topic: RealtimeTopic, listener: RealtimeListener) => () => void
  watchJob: (jobId: string, listener: RealtimeListener) => () => void
  flushSubscriptionsNow: () => Promise<void>
  /** Request HTTP snapshot reload for current topics (resync). */
  onResync: (listener: (topics: RealtimeTopic[]) => void) => () => void
}

export const RealtimeGatewayKey: InjectionKey<RealtimeGateway> = Symbol('realtimeGateway')

/** Normalize envelope payload to a plain object for UI handlers. */
export function realtimePayload(envelope: RealtimeEnvelope): Record<string, unknown> {
  const payload = envelope.payload
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(payload)) {
      out[key] = value
    }
    return out
  }
  return { value: payload }
}

function newConnectionId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }
  return `conn-${Math.random().toString(36).slice(2, 10)}`
}

export function provideRealtimeGateway(): RealtimeGateway {
  const connected = ref(false)
  const connectionId = newConnectionId()
  const listenersByTopic = new Map<RealtimeTopic, Set<RealtimeListener>>()
  const resyncListeners = new Set<(topics: RealtimeTopic[]) => void>()
  const refCounts = new Map<RealtimeTopic, number>()
  const reducer = new RealtimeReducer()
  let abort: AbortController | null = null
  let desiredTopics: RealtimeTopic[] = []
  let reconnectAttempt = 0
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let subscriptionRetryTimer: ReturnType<typeof setTimeout> | null = null
  let idleCloseTimer: ReturnType<typeof setTimeout> | null = null
  let streamOpen = false
  let subscriptionsHealthy = false
  let subscriptionRetryAttempt = 0
  let stopped = false
  const ZERO_TOPIC_CLOSE_MS = 30_000

  function updateConnected(): void {
    connected.value = streamOpen && subscriptionsHealthy
  }

  function scheduleSubscriptionRetry(): void {
    if (stopped || subscriptionRetryTimer) return
    const delay = Math.min(30_000, 1000 * 2 ** subscriptionRetryAttempt)
    subscriptionRetryAttempt += 1
    subscriptionRetryTimer = setTimeout(() => {
      subscriptionRetryTimer = null
      void syncSubscriptions()
    }, delay)
  }

  async function syncSubscriptions(): Promise<void> {
    if (stopped) return
    try {
      await putRealtimeSubscriptions(connectionId, desiredTopics)
      subscriptionsHealthy = true
      subscriptionRetryAttempt = 0
      if (subscriptionRetryTimer) {
        clearTimeout(subscriptionRetryTimer)
        subscriptionRetryTimer = null
      }
    } catch (error) {
      subscriptionsHealthy = false
      scheduleSubscriptionRetry()
      console.warn('[realtime] subscription flush failed', error)
    } finally {
      updateConnected()
    }
  }

  const flushSubscriptions = useDebounceFn(async () => {
    await syncSubscriptions()
  }, 50)

  function recomputeDesiredTopics(): void {
    desiredTopics = [...refCounts.keys()].filter((topic) => (refCounts.get(topic) ?? 0) > 0)
    subscriptionsHealthy = false
    updateConnected()
    void flushSubscriptions()
    ensureStreamForTopics()
  }

  async function flushSubscriptionsNow(): Promise<void> {
    await syncSubscriptions()
  }

  function dispatch(envelope: RealtimeEnvelope): void {
    if (!reducer.reduce(envelope)) return

    if (envelope.type === 'realtime.resync-required') {
      for (const listener of resyncListeners) {
        listener(desiredTopics)
      }
      subscriptionsHealthy = false
      updateConnected()
      void syncSubscriptions()
      return
    }

    if (envelope.type === 'auth.session.expired') {
      stopped = true
      abort?.abort()
      handleUnauthorizedApiError()
      return
    }

    const topic = parseRealtimeTopic(String(envelope.topic))
    if (!topic) return
    const set = listenersByTopic.get(topic)
    if (!set) return
    for (const listener of set) {
      listener(envelope)
    }
  }

  function backoffMs(): number {
    const base = Math.min(30_000, 1000 * 2 ** reconnectAttempt)
    const jitter = Math.floor(Math.random() * 250)
    return base + jitter
  }

  function scheduleReconnect(): void {
    if (stopped || reconnectTimer) return
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return
    const delay = backoffMs()
    reconnectAttempt += 1
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      startStream()
    }, delay)
  }

  function ensureStreamForTopics(): void {
    if (idleCloseTimer) {
      clearTimeout(idleCloseTimer)
      idleCloseTimer = null
    }
    if (desiredTopics.length === 0) {
      // Doc §5.2 / §25.4: no topics → delay 30s then close the SSE.
      if (abort || connected.value) {
        idleCloseTimer = setTimeout(() => {
          idleCloseTimer = null
          if (desiredTopics.length > 0 || stopped) return
          abort?.abort()
          streamOpen = false
          updateConnected()
          abort = null
        }, ZERO_TOPIC_CLOSE_MS)
      }
      return
    }
    if (!connected.value && !abort) {
      startStream()
    }
  }

  function startStream(): void {
    if (stopped) return
    abort?.abort()
    const controller = new AbortController()
    abort = controller
    streamOpen = false
    subscriptionsHealthy = false
    updateConnected()

    void syncSubscriptions()

    void connectRealtimeStream(connectionId, dispatch, {
      signal: controller.signal,
      lastEventId: reducer.getLastEventId() || null,
      onOpen: () => {
        if (abort !== controller || controller.signal.aborted) return
        streamOpen = true
        reconnectAttempt = 0
        updateConnected()
      }
    })
      .catch((error) => {
        if (controller.signal.aborted) return
        if (error instanceof ApiError && error.httpStatus === 401) {
          stopped = true
          handleUnauthorizedApiError()
          return
        }
        console.warn('[realtime] stream ended', error)
      })
      .finally(() => {
        if (abort === controller) {
          streamOpen = false
          updateConnected()
          abort = null
          if (!stopped && desiredTopics.length > 0) {
            scheduleReconnect()
          }
        }
      })
  }

  function onOnline(): void {
    if (stopped) return
    reconnectAttempt = 0
    void syncSubscriptions()
    if (!connected.value && desiredTopics.length > 0) {
      if (!abort) startStream()
    }
  }

  function onVisibilityChange(): void {
    if (document.visibilityState === 'visible') onOnline()
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('online', onOnline)
    document.addEventListener('visibilitychange', onVisibilityChange)
  }

  const gateway: RealtimeGateway = {
    connected,
    connectionId,
    flushSubscriptionsNow,
    watchTopic(topic: RealtimeTopic, listener: RealtimeListener) {
      const set = listenersByTopic.get(topic) ?? new Set()
      set.add(listener)
      listenersByTopic.set(topic, set)
      refCounts.set(topic, (refCounts.get(topic) ?? 0) + 1)
      recomputeDesiredTopics()

      return () => {
        set.delete(listener)
        if (set.size === 0) listenersByTopic.delete(topic)
        const next = (refCounts.get(topic) ?? 1) - 1
        if (next <= 0) refCounts.delete(topic)
        else refCounts.set(topic, next)
        recomputeDesiredTopics()
      }
    },
    watchJob(jobId: string, listener: RealtimeListener) {
      return gateway.watchTopic(jobTopic(jobId), listener)
    },
    onResync(listener) {
      resyncListeners.add(listener)
      return () => resyncListeners.delete(listener)
    }
  }

  provide(RealtimeGatewayKey, gateway)

  onScopeDispose(() => {
    stopped = true
    abort?.abort()
    if (reconnectTimer) clearTimeout(reconnectTimer)
    if (subscriptionRetryTimer) clearTimeout(subscriptionRetryTimer)
    if (idleCloseTimer) clearTimeout(idleCloseTimer)
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', onOnline)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  })

  return gateway
}

export function useRealtimeGateway(): RealtimeGateway {
  const gateway = inject(RealtimeGatewayKey)
  if (!gateway) {
    throw new Error('RealtimeGateway not provided')
  }
  return gateway
}
