import {
  inject,
  onScopeDispose,
  provide,
  ref,
  watch,
  type InjectionKey,
  type Ref
} from 'vue'
import { useDebounceFn } from '@vueuse/core'
import { connectHubStream, putHubSubscriptions } from '@renderer/api/job-event-hub'
import type { HubEnvelope, HubTopic } from '@shared/contracts/job-event-hub'
import { jobTopic } from '@shared/contracts/job-event-hub'
import type { JobSseEvent } from '@shared/contracts/sse'
import { jobNeedsRealtimeWatch } from '@shared/job-realtime'

export type JobHubListener = (event: JobSseEvent) => void
export type TopicHubListener = (envelope: HubEnvelope) => void

export interface JobEventHub {
  connected: Ref<boolean>
  connectionId: string
  watchTopic: (topic: HubTopic, listener: TopicHubListener) => () => void
  watchJob: (jobId: string, listener: JobHubListener) => () => void
  onAnyEvent: (listener: TopicHubListener) => () => void
  /** @deprecated Prefer onAnyEvent */
  onAnyJobEvent: (listener: TopicHubListener) => () => void
}

const JobEventHubKey: InjectionKey<JobEventHub> = Symbol('jobEventHub')

function newConnectionId(): string {
  return `conn-${Math.random().toString(36).slice(2, 10)}`
}

export function provideJobEventHub(): JobEventHub {
  const connected = ref(false)
  const connectionId = newConnectionId()
  const listenersByTopic = new Map<HubTopic, Set<TopicHubListener>>()
  const globalListeners = new Set<TopicHubListener>()
  const refCounts = new Map<HubTopic, number>()
  let abort: AbortController | null = null
  let desiredTopics: HubTopic[] = []
  let lastSeq: number | null = null

  const flushSubscriptions = useDebounceFn(async () => {
    if (!connected.value) return
    try {
      await putHubSubscriptions(connectionId, desiredTopics)
    } catch (error) {
      console.warn('[event-hub] subscription flush failed', error)
    }
  }, 50)

  function recomputeDesiredTopics(): void {
    desiredTopics = [...refCounts.keys()].filter((topic) => (refCounts.get(topic) ?? 0) > 0)
    void flushSubscriptions()
  }

  function dispatch(envelope: HubEnvelope): void {
    if (typeof envelope.seq === 'number' && Number.isFinite(envelope.seq)) {
      lastSeq = envelope.seq
    }
    if (envelope.event === 'resync') {
      void putHubSubscriptions(connectionId, desiredTopics).catch((error) => {
        console.warn('[event-hub] resync subscription failed', error)
      })
      return
    }
    for (const listener of globalListeners) {
      listener(envelope)
    }
    const set = listenersByTopic.get(envelope.topic)
    if (!set) return
    for (const listener of set) {
      listener(envelope)
    }
  }

  function startStream(): void {
    abort?.abort()
    const controller = new AbortController()
    abort = controller
    connected.value = true
    void putHubSubscriptions(connectionId, desiredTopics).catch((error) => {
      console.warn('[event-hub] initial subscription failed', error)
    })

    void connectHubStream(connectionId, dispatch, {
      signal: controller.signal,
      lastEventId: lastSeq
    })
      .catch((error) => {
        if (!controller.signal.aborted) {
          console.warn('[event-hub] stream ended', error)
        }
      })
      .finally(() => {
        if (abort === controller) {
          connected.value = false
          abort = null
          window.setTimeout(startStream, 3000)
        }
      })
  }

  startStream()

  const hub: JobEventHub = {
    connected,
    connectionId,
    watchTopic(topic: HubTopic, listener: TopicHubListener) {
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
    watchJob(jobId: string, listener: JobHubListener) {
      return hub.watchTopic(jobTopic(jobId), (envelope) => {
        if (
          envelope.event === 'job_snapshot' ||
          envelope.event === 'plan_progress' ||
          envelope.event === 'task_progress' ||
          envelope.event === 'job_done' ||
          envelope.event === 'error'
        ) {
          listener(envelope)
        }
      })
    },
    onAnyEvent(listener) {
      globalListeners.add(listener)
      return () => globalListeners.delete(listener)
    },
    onAnyJobEvent(listener) {
      return hub.onAnyEvent(listener)
    }
  }

  provide(JobEventHubKey, hub)
  return hub
}

export function useJobEventHub(): JobEventHub {
  const hub = inject(JobEventHubKey)
  if (!hub) {
    throw new Error('JobEventHub not provided')
  }
  return hub
}

export function useJobHubWatch(
  jobId: () => string | null | undefined,
  status: () => string | null | undefined,
  listener: JobHubListener
): void {
  const hub = useJobEventHub()
  let release: (() => void) | null = null

  const sync = (): void => {
    release?.()
    release = null
    const id = jobId()
    const st = status()
    if (!id || !st || !jobNeedsRealtimeWatch(st)) return
    release = hub.watchJob(id, listener)
  }

  watch([jobId, status], sync, { immediate: true })
  onScopeDispose(() => release?.())
}
