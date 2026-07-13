/**
 * Production Tasks store (C10–C13).
 *
 * - List/detail load `/api/v3/jobs` snapshots with legacy display projection overlaid by V3 control fields.
 * - Actions prefer server `availableActions` (no recovery补算).
 * - When `stateRevision` is present, commands go through `/api/v3`.
 */
import { computed, ref, watch, type ComputedRef, type Ref } from 'vue'
import { useRouter } from 'vue-router'
import { useDebounceFn } from '@vueuse/core'
import {
  pauseJob,
  continueJob,
  resumeJob,
  restartJob,
  deleteJob,
  type ThreadJob
} from '@renderer/api/jobs'
import {
  fetchV3Jobs,
  fetchV3Job,
  pauseV3Job,
  continueV3Job,
  cancelV3Job,
  restartExecutionV3Job
} from '@renderer/api/v3-jobs'
import {
  connectControlPlaneEventsStream,
  ControlPlaneEventsResyncRequiredError
} from '@renderer/api/v3-events'
import { jobNeedsRealtimeWatch } from '@shared/job-realtime'
import { useJobEventHub } from '@renderer/composables/useJobEventHub'
import type { JobSseEvent } from '@renderer/api/jobs'
import { EventReducer } from '@renderer/stores/event-reducer'
import { JobsStore } from '@renderer/stores/jobs-store'
import {
  canCancel,
  canDelete,
  filterActions,
  getPauseButtonText
} from '@renderer/stores/ui-actions'

export interface UseControlPlaneJobsStoreOptions {
  selectedJobId: Ref<string | null>
}

function actionsFor(job: ThreadJob | null): readonly string[] {
  if (!job?.availableActions) return []
  return filterActions(job.availableActions, { state: mapLegacyStatusToState(job.status) })
}

function mapLegacyStatusToState(status: string): string {
  switch (status) {
    case 'planning':
      return 'planning_running'
    case 'plan_ready':
    case 'plan_editing':
      return 'plan_review'
    case 'pending':
      return 'execution_queued'
    case 'running':
      return 'execution_running'
    case 'pausing':
      return 'pausing'
    case 'paused':
      return 'paused'
    case 'completed':
      return 'succeeded'
    case 'failed':
      return 'failed'
    case 'cancelled':
      return 'cancelled'
    default:
      return status
  }
}

function hasV3Projection(job: ThreadJob | null | undefined): job is ThreadJob & {
  stateRevision: number
  availableActions: readonly string[]
} {
  return job?.stateRevision !== undefined && Array.isArray(job.availableActions)
}

export function useControlPlaneJobsStore(options: UseControlPlaneJobsStoreOptions): {
  statusFilter: Ref<string>
  searchQuery: Ref<string>
  jobs: Ref<ThreadJob[]>
  total: Ref<number>
  loadingList: Ref<boolean>
  loadingDetail: Ref<boolean>
  error: Ref<string | null>
  actionError: Ref<string | null>
  runningAction: Ref<string | null>
  detail: Ref<ThreadJob | null>
  selectedJob: ComputedRef<ThreadJob | null>
  loadJobs: () => Promise<void>
  loadDetail: (id: string) => Promise<void>
  applyJobPatch: (job: ThreadJob) => void
  syncHubWatch: () => void
  startHubPolling: () => void
  stopHubPolling: () => void
  handlePause: () => Promise<void>
  handleContinue: () => Promise<void>
  handleRestart: () => Promise<void>
  handleCancel: () => Promise<void>
  handleDelete: () => Promise<void>
  canPause: ComputedRef<boolean>
  canContinue: ComputedRef<boolean>
  canRestart: ComputedRef<boolean>
  canCancelAction: ComputedRef<boolean>
  canDeleteAction: ComputedRef<boolean>
  pauseButtonText: ComputedRef<string | null>
  v3Store: JobsStore
} {
  const { selectedJobId } = options
  const router = useRouter()
  const hub = useJobEventHub()
  const v3Store = new JobsStore()

  const statusFilter = ref('all')
  const searchQuery = ref('')
  const jobs = ref<ThreadJob[]>([])
  const total = ref(0)
  const loadingList = ref(true)
  const loadingDetail = ref(false)
  const error = ref<string | null>(null)
  const actionError = ref<string | null>(null)
  const runningAction = ref<string | null>(null)
  const detail = ref<ThreadJob | null>(null)

  let pollTimer: ReturnType<typeof setInterval> | null = null
  let hubRelease: (() => void) | null = null
  let hubListRelease: (() => void) | null = null
  let streamAbort: AbortController | null = null
  let streamRetryTimer: ReturnType<typeof setTimeout> | null = null
  let loadDetailToken = 0
  let loadJobsToken = 0
  const eventReducer = new EventReducer()

  const selectedJob = computed(() =>
    selectedJobId.value
      ? (detail.value ?? jobs.value.find((j) => j.id === selectedJobId.value) ?? null)
      : null
  )

  const selectedActions = computed(() => actionsFor(selectedJob.value))

  const canPause = computed(() => selectedActions.value.includes('pause'))
  const canContinue = computed(() => selectedActions.value.includes('continue'))
  const canRestart = computed(() => selectedActions.value.includes('restart_execution'))
  const canCancelAction = computed(() => canCancel(selectedActions.value))
  const canDeleteAction = computed(() => {
    const job = selectedJob.value
    if (!job) return false
    return canDelete(selectedActions.value) && !['running', 'planning', 'pausing'].includes(job.status)
  })
  const pauseButtonText = computed(() =>
    selectedJob.value
      ? getPauseButtonText({ state: mapLegacyStatusToState(selectedJob.value.status) })
      : null
  )

  function mergeJobPatch(existing: ThreadJob | null | undefined, job: ThreadJob): ThreadJob {
    const has = (key: string): boolean => key in job
    return {
      ...(existing ?? {}),
      ...job,
      plan: has('plan') ? job.plan : (existing?.plan ?? null),
      abilities: has('abilities') ? job.abilities : (existing?.abilities ?? []),
      planProgress: has('planProgress') ? job.planProgress : existing?.planProgress,
      taskProgress: has('taskProgress') ? job.taskProgress : existing?.taskProgress,
      availableActions: has('availableActions')
        ? job.availableActions
        : existing?.availableActions,
      stateRevision: has('stateRevision') ? job.stateRevision : existing?.stateRevision
    } as ThreadJob
  }

  const debouncedRefreshJobs = useDebounceFn(() => void loadJobs({ silent: true }), 150)
  const debouncedRefreshSelectedDetail = useDebounceFn((jobId: string) => {
    if (selectedJobId.value === jobId) {
      void loadDetail(jobId, { silent: true })
    }
  }, 100)

  function scheduleResync(jobId?: string): void {
    eventReducer.clearNeedsResync()
    debouncedRefreshJobs()
    if (jobId) {
      debouncedRefreshSelectedDetail(jobId)
      return
    }
    if (selectedJobId.value) {
      debouncedRefreshSelectedDetail(selectedJobId.value)
    }
  }

  function mergeIncomingJob(
    existing: ThreadJob | null | undefined,
    job: ThreadJob
  ): ThreadJob | null {
    if (hasV3Projection(job)) {
      const decision = v3Store.mergeJob(
        {
          id: job.id,
          state: mapLegacyStatusToState(job.status),
          stateRevision: job.stateRevision,
          availableActions: job.availableActions
        },
        'authoritative_snapshot'
      )
      if (decision.kind === 'ignore_stale') {
        return existing ?? null
      }
      if (decision.kind === 'resync') {
        scheduleResync(job.id)
        return existing ?? null
      }
    }
    return mergeJobPatch(existing, job)
  }

  function applyJobPatch(job: ThreadJob): void {
    const currentDetail = detail.value?.id === job.id ? detail.value : null
    const nextDetail = mergeIncomingJob(currentDetail, job)
    const nextSelected = mergeIncomingJob(selectedJobId.value === job.id ? currentDetail : null, job)

    if (detail.value?.id === job.id) {
      if (nextDetail) {
        detail.value = nextDetail
      }
    } else if (selectedJobId.value === job.id) {
      if (nextSelected) {
        detail.value = nextSelected
      }
    }
    const idx = jobs.value.findIndex((item) => item.id === job.id)
    if (idx >= 0) {
      const nextListItem = mergeIncomingJob(jobs.value[idx], job)
      if (nextListItem) {
        jobs.value[idx] = nextListItem
      }
    }
  }

  function syncHubWatch(): void {
    hubRelease?.()
    hubRelease = null
    if (hasV3Projection(selectedJob.value)) return
    const jobId = selectedJobId.value
    const status = selectedJob.value?.status
    if (!jobId || !status || !jobNeedsRealtimeWatch(status)) return
    hubRelease = hub.watchJob(jobId, (event) => handleHubEvent(jobId, event))
  }

  function handleHubEvent(_jobId: string, event: JobSseEvent): void {
    if (event.event === 'job_snapshot' || event.event === 'job_done') {
      applyJobPatch(event.data.job)
      if (event.event === 'job_done') syncHubWatch()
      return
    }
    if (event.event === 'plan_progress' && selectedJob.value) {
      applyJobPatch({ ...selectedJob.value, planProgress: event.data.planProgress })
    }
    if (event.event === 'task_progress' && selectedJob.value) {
      applyJobPatch({ ...selectedJob.value, taskProgress: event.data.taskProgress })
    }
  }

  async function loadJobs(options?: { silent?: boolean }): Promise<void> {
    const token = ++loadJobsToken
    const silent = options?.silent ?? false
    if (!silent) loadingList.value = true
    error.value = null
    try {
      const res = await fetchV3Jobs(statusFilter.value, 1, 50, searchQuery.value)
      if (token !== loadJobsToken) return
      const currentById = new Map(jobs.value.map((job) => [job.id, job] as const))
      jobs.value = res.data.jobs
        .map((job) => mergeIncomingJob(currentById.get(job.id), job))
        .filter((job): job is ThreadJob => job !== null)
      total.value = res.data.total
      const currentId = selectedJobId.value
      const stillExists = currentId ? res.data.jobs.some((job) => job.id === currentId) : false
      if (currentId && !stillExists) {
        await router.replace({ name: 'tasks' })
      }
    } catch (err) {
      if (!silent) {
        error.value = err instanceof Error ? err.message : 'Failed to load jobs'
      }
    } finally {
      if (!silent) loadingList.value = false
    }
  }

  async function loadDetail(jobId: string, options?: { silent?: boolean }): Promise<void> {
    const token = ++loadDetailToken
    const silent = options?.silent ?? false
    if (!silent) loadingDetail.value = true
    try {
      const res = await fetchV3Job(jobId)
      if (token !== loadDetailToken) return
      const merged = mergeIncomingJob(detail.value?.id === jobId ? detail.value : null, res.data.job)
      if (merged) {
        applyJobPatch(merged)
      }
      syncHubWatch()
    } catch (err) {
      if (token !== loadDetailToken) return
      if (!silent) {
        error.value = err instanceof Error ? err.message : 'Failed to load job detail'
        detail.value = null
      }
    } finally {
      if (!silent && token === loadDetailToken) loadingDetail.value = false
    }
  }

  eventReducer.setResyncCallback((info) => {
    eventReducer.resetCursor(info.newEventId)
    streamAbort?.abort()
    scheduleResync()
  })
  eventReducer.registerHandler('job.changed', (event) => {
    debouncedRefreshJobs()
    debouncedRefreshSelectedDetail(event.entityId)
  })

  function startV3EventsStream(): void {
    streamAbort?.abort()
    if (streamRetryTimer) {
      clearTimeout(streamRetryTimer)
      streamRetryTimer = null
    }

    const controller = new AbortController()
    streamAbort = controller

    void connectControlPlaneEventsStream(
      (event) => {
        eventReducer.reduce({
          eventId: event.eventId,
          topic: event.topic,
          type: event.type,
          entityId: event.entityId,
          revision: event.revision,
          payload: event.payload
        })
      },
      {
        signal: controller.signal,
        lastEventId: eventReducer.getLastEventId()
      }
    )
      .catch((error) => {
        if (error instanceof ControlPlaneEventsResyncRequiredError) {
          eventReducer.resetCursor(error.restartFromEventId)
          scheduleResync()
          return
        }
        if (!controller.signal.aborted) {
          console.warn('[control-plane-events] stream ended', error)
        }
      })
      .finally(() => {
        if (streamAbort === controller) {
          streamAbort = null
          streamRetryTimer = window.setTimeout(() => {
            startV3EventsStream()
          }, 3000)
        }
      })
  }

  function startHubPolling(): void {
    startV3EventsStream()
    hubListRelease = hub.onAnyJobEvent((envelope) => {
      if (!envelope.topic.startsWith('job:')) return
      if (hasV3Projection(selectedJob.value) || jobs.value.some((job) => hasV3Projection(job))) {
        return
      }
      debouncedRefreshJobs()
      if (selectedJobId.value && envelope.topic === `job:${selectedJobId.value}`) {
        debouncedRefreshSelectedDetail(selectedJobId.value)
      }
    })
    pollTimer = setInterval(() => {
      const usingLegacyHub = !hasV3Projection(selectedJob.value) && !jobs.value.some((job) => hasV3Projection(job))
      if (!streamAbort && !usingLegacyHub) {
        void loadJobs({ silent: true })
        const jobId = selectedJobId.value
        if (jobId) void loadDetail(jobId, { silent: true })
        return
      }
      if (usingLegacyHub && !hub.connected.value) {
        void loadJobs({ silent: true })
        const jobId = selectedJobId.value
        if (jobId) void loadDetail(jobId, { silent: true })
      }
    }, 30_000)
  }

  function stopHubPolling(): void {
    hubListRelease?.()
    hubRelease?.()
    hubListRelease = null
    hubRelease = null
    streamAbort?.abort()
    streamAbort = null
    if (streamRetryTimer) {
      clearTimeout(streamRetryTimer)
      streamRetryTimer = null
    }
    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
  }

  watch(statusFilter, () => void loadJobs())
  const debouncedSearch = useDebounceFn(() => void loadJobs(), 300)
  watch(searchQuery, () => void debouncedSearch())

  watch(
    selectedJobId,
    (jobId, prevJobId) => {
      if (jobId !== prevJobId) {
        hubRelease?.()
        hubRelease = null
      }
      if (!jobId) {
        detail.value = null
        return
      }
      void loadDetail(jobId)
    },
    { immediate: true }
  )

  watch(() => selectedJob.value?.status, () => syncHubWatch())

  async function runAction(action: string, fn: () => Promise<unknown>): Promise<void> {
    if (!selectedJob.value) return
    runningAction.value = action
    actionError.value = null
    try {
      await fn()
      await loadDetail(selectedJob.value.id)
    } catch (err) {
      actionError.value = err instanceof Error ? err.message : 'Action failed'
    } finally {
      runningAction.value = null
    }
  }

  async function handlePause(): Promise<void> {
    const job = selectedJob.value
    if (!job) return
    await runAction('pause', async () => {
      if (job.stateRevision !== undefined) {
        await pauseV3Job(job.id, job.stateRevision)
      } else {
        await pauseJob(job.id)
      }
    })
  }

  async function handleContinue(): Promise<void> {
    const job = selectedJob.value
    if (!job) return
    await runAction('continue', async () => {
      if (job.stateRevision !== undefined) {
        await continueV3Job(job.id, job.stateRevision)
        return
      }
      if (job.lifecycle === 'paused' || job.status === 'paused') {
        await resumeJob(job.id)
        return
      }
      await continueJob(job.id)
    })
  }

  async function handleRestart(): Promise<void> {
    const job = selectedJob.value
    if (!job) return
    await runAction('restart', async () => {
      if (job.stateRevision !== undefined) {
        await restartExecutionV3Job(job.id, job.stateRevision)
      } else {
        await restartJob(job.id)
      }
    })
  }

  async function handleCancel(): Promise<void> {
    const job = selectedJob.value
    if (!job || job.stateRevision === undefined) return
    await runAction('cancel', async () => {
      await cancelV3Job(job.id, job.stateRevision!)
    })
  }

  async function handleDelete(): Promise<void> {
    const job = selectedJob.value
    if (!job) return
    runningAction.value = 'delete'
    actionError.value = null
    try {
      await deleteJob(job.id)
      detail.value = null
      await router.replace({ name: 'tasks' })
      await loadJobs()
    } catch (err) {
      actionError.value = err instanceof Error ? err.message : 'Failed to delete'
    } finally {
      runningAction.value = null
    }
  }

  return {
    statusFilter,
    searchQuery,
    jobs,
    total,
    loadingList,
    loadingDetail,
    error,
    actionError,
    runningAction,
    detail,
    selectedJob,
    loadJobs,
    loadDetail,
    applyJobPatch,
    syncHubWatch,
    startHubPolling,
    stopHubPolling,
    handlePause,
    handleContinue,
    handleRestart,
    handleCancel,
    handleDelete,
    canPause,
    canContinue,
    canRestart,
    canCancelAction,
    canDeleteAction,
    pauseButtonText,
    v3Store
  }
}
