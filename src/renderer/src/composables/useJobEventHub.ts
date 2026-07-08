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
import { connectJobHubStream, putJobHubSubscriptions } from '@renderer/api/job-event-hub'
import type { JobHubEnvelope } from '@shared/contracts/job-event-hub'
import type { JobSseEvent } from '@shared/contracts/sse'
import { jobNeedsRealtimeWatch } from '@shared/job-realtime'

export type JobHubListener = (event: JobSseEvent) => void

export interface JobEventHub {
  connected: Ref<boolean>
  watchJob: (jobId: string, listener: JobHubListener) => () => void
  onAnyJobEvent: (listener: (envelope: JobHubEnvelope) => void) => () => void
}

const JobEventHubKey: InjectionKey<JobEventHub> = Symbol('jobEventHub')

export function provideJobEventHub(): JobEventHub {
  const connected = ref(false)
  const listenersByJob = new Map<string, Set<JobHubListener>>()
  const globalListeners = new Set<(envelope: JobHubEnvelope) => void>()
  const refCounts = new Map<string, number>()
  let abort: AbortController | null = null
  let desiredJobIds: string[] = []

  const flushSubscriptions = useDebounceFn(async () => {
    if (!connected.value) return
    try {
      await putJobHubSubscriptions(desiredJobIds)
    } catch {
      // stream may reconnect; subscriptions will retry on next flush
    }
  }, 50)

  function recomputeDesiredJobIds(): void {
    desiredJobIds = [...refCounts.keys()].filter((jobId) => (refCounts.get(jobId) ?? 0) > 0)
    void flushSubscriptions()
  }

  function dispatch(envelope: JobHubEnvelope): void {
    for (const listener of globalListeners) {
      listener(envelope)
    }
    const set = listenersByJob.get(envelope.jobId)
    if (!set) return
    for (const listener of set) {
      listener(envelope.payload)
    }
  }

  function startStream(): void {
    abort?.abort()
    const controller = new AbortController()
    abort = controller
    connected.value = true
    void putJobHubSubscriptions(desiredJobIds).catch(() => {})

    void connectJobHubStream(dispatch, { signal: controller.signal })
      .catch(() => {})
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
    watchJob(jobId: string, listener: JobHubListener) {
      const set = listenersByJob.get(jobId) ?? new Set()
      set.add(listener)
      listenersByJob.set(jobId, set)
      refCounts.set(jobId, (refCounts.get(jobId) ?? 0) + 1)
      recomputeDesiredJobIds()

      return () => {
        set.delete(listener)
        if (set.size === 0) listenersByJob.delete(jobId)
        const next = (refCounts.get(jobId) ?? 1) - 1
        if (next <= 0) refCounts.delete(jobId)
        else refCounts.set(jobId, next)
        recomputeDesiredJobIds()
      }
    },
    onAnyJobEvent(listener) {
      globalListeners.add(listener)
      return () => globalListeners.delete(listener)
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
