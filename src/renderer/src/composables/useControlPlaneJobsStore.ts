/**
 * Production Tasks store (C10–C13).
 *
 * - List/detail load `/api/v3/jobs` snapshots.
 * - Server `availableActions` is authoritative (no recovery补算).
 * - Commands always use `/api/v3`; the API is never selected per job.
 */
import { computed, ref, watch, type ComputedRef, type Ref } from 'vue'
import { useRouter } from 'vue-router'
import { useDebounceFn } from '@vueuse/core'
import type { ThreadJob } from '@renderer/api/jobs'
import {
  fetchV3Jobs,
  fetchV3Job,
  pauseV3Job,
  continueV3Job,
  cancelV3Job,
  restartExecutionV3Job,
  newIdempotencyKey
} from '@renderer/api/v3-jobs'
import {
  connectControlPlaneEventsStream,
  ControlPlaneEventsResyncRequiredError
} from '@renderer/api/v3-events'
import { ApiError } from '@renderer/api/client'
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
  return filterActions(job.availableActions, { state: jobState(job) })
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

function jobState(job: ThreadJob): string {
  return (job as ThreadJob & { state?: string }).state ?? mapLegacyStatusToState(job.status)
}

function requireV3Revision(job: ThreadJob): number {
  if (typeof job.stateRevision !== 'number') {
    throw new Error('Control-plane job is missing its state revision')
  }
  return job.stateRevision
}

function isRevisionConflict(error: unknown): boolean {
  return error instanceof ApiError && error.status === 409 && error.message === 'job.revision_conflict'
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
  let streamAbort: AbortController | null = null
  let streamRetryTimer: number | null = null
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
    const stateRevision = requireV3Revision(job)
    const decision = v3Store.mergeJob(
      {
        id: job.id,
        state: jobState(job),
        stateRevision,
        availableActions: job.availableActions ?? []
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
    return mergeJobPatch(existing, job)
  }

  function applyJobPatch(job: ThreadJob): void {
    const idx = jobs.value.findIndex((item) => item.id === job.id)
    const existing =
      detail.value?.id === job.id
        ? detail.value
        : (idx >= 0 ? jobs.value[idx] : null)
    const merged = mergeIncomingJob(existing, job)
    if (!merged) return

    if (detail.value?.id === job.id || selectedJobId.value === job.id) {
      detail.value = merged
    }
    if (idx >= 0) {
      jobs.value[idx] = merged
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
      applyJobPatch(res.data.job)
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
    void Promise.all([
      loadJobs({ silent: true }),
      selectedJobId.value ? loadDetail(selectedJobId.value, { silent: true }) : Promise.resolve()
    ]).finally(() => eventReducer.clearNeedsResync())
  })
  eventReducer.registerHandler('job.changed', (event) => {
    const current = v3Store.getJob(event.entityId)
    if (current && event.revision <= current.stateRevision) return
    if (current && event.revision > current.stateRevision + 1) {
      scheduleResync(event.entityId)
      return
    }
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
    pollTimer = setInterval(() => {
      if (!streamAbort) {
        void loadJobs({ silent: true })
        const jobId = selectedJobId.value
        if (jobId) void loadDetail(jobId, { silent: true })
      }
    }, 30_000)
  }

  function stopHubPolling(): void {
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
    (jobId) => {
      if (!jobId) {
        detail.value = null
        return
      }
      void loadDetail(jobId)
    },
    { immediate: true }
  )

  async function runAction(
    action: string,
    fn: (job: ThreadJob, idempotencyKey: string) => Promise<unknown>
  ): Promise<void> {
    const job = selectedJob.value
    if (!job) return
    runningAction.value = action
    actionError.value = null
    const idempotencyKey = newIdempotencyKey()
    try {
      await fn(job, idempotencyKey)
      await loadDetail(job.id)
    } catch (err) {
      if (isRevisionConflict(err)) {
        await loadDetail(job.id)
        actionError.value = '任务状态已变化，请确认后重试'
        return
      }
      actionError.value = err instanceof Error ? err.message : 'Action failed'
    } finally {
      runningAction.value = null
    }
  }

  async function handlePause(): Promise<void> {
    await runAction('pause', (job, idempotencyKey) =>
      pauseV3Job(job.id, requireV3Revision(job), idempotencyKey)
    )
  }

  async function handleContinue(): Promise<void> {
    await runAction('continue', (job, idempotencyKey) =>
      continueV3Job(job.id, requireV3Revision(job), idempotencyKey)
    )
  }

  async function handleRestart(): Promise<void> {
    await runAction('restart_execution', (job, idempotencyKey) =>
      restartExecutionV3Job(job.id, requireV3Revision(job), idempotencyKey)
    )
  }

  async function handleCancel(): Promise<void> {
    await runAction('cancel', (job, idempotencyKey) =>
      cancelV3Job(job.id, requireV3Revision(job), 'user_cancelled', idempotencyKey)
    )
  }

  async function handleDelete(): Promise<void> {
    actionError.value = 'Deleting V3 jobs is not supported by the control-plane API'
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
