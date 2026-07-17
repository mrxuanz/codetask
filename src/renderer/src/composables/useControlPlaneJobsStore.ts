/**
 * Production Tasks store (C10–C13).
 *
 * - List/detail load `/api/v3/jobs` snapshots.
 * - Server `availableActions` is authoritative (no recovery补算).
 * - Commands always use `/api/v3`; the API is never selected per job.
 * - Realtime: single window JobEventHub (`/api/realtime`); no second `/api/v3/events`.
 */
import { computed, ref, watch, type ComputedRef, type Ref } from 'vue'
import { useRouter } from 'vue-router'
import { useDebounceFn } from '@vueuse/core'
import type { ThreadJob } from '@renderer/api/jobs'
import {
  createV3JobsApi,
  newIdempotencyKey,
  resolveJobsApi,
  type JobsApi
} from '@renderer/api/jobs-api'
import { fetchControlPlaneGeneration } from '@renderer/api/control-plane-generation'
import { ApiError } from '@renderer/api/client'
import { JobsStore } from '@renderer/stores/jobs-store'
import {
  canCancel,
  canDelete,
  filterActions,
  getPauseButtonText
} from '@renderer/stores/ui-actions'
import { toast, toastError } from '@renderer/lib/toast'
import { useJobEventHub } from '@renderer/composables/useJobEventHub'
import type { JobSseEvent } from '@shared/contracts/sse'
import { jobNeedsRealtimeWatch } from '@shared/job-realtime'

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

function isRevisionConflict(error: unknown): boolean {
  return (
    error instanceof ApiError && error.httpStatus === 409 && error.code === 'job.revision_conflict'
  )
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
  const hub = useJobEventHub()
  const v3Store = new JobsStore()
  let jobsApi: JobsApi = createV3JobsApi()
  let isAuthoritative = false
  const apiReady = (async () => {
    const generation = await fetchControlPlaneGeneration()
    isAuthoritative = generation === 'v3_authoritative'
    jobsApi = await resolveJobsApi()
    return jobsApi
  })()

  function requireV3Revision(job: ThreadJob): number {
    if (typeof job.stateRevision !== 'number') {
      throw new Error('Control-plane job is missing its state revision')
    }
    return job.stateRevision
  }

  function requireCommandRevision(job: ThreadJob): number {
    if (!isAuthoritative) {
      return typeof job.stateRevision === 'number' ? job.stateRevision : 0
    }
    return requireV3Revision(job)
  }

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
  const hubListReleases = new Map<string, () => void>()
  let loadDetailToken = 0
  let loadJobsToken = 0

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
    return (
      canDelete(selectedActions.value) && !['running', 'planning', 'pausing'].includes(job.status)
    )
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
      availableActions: has('availableActions') ? job.availableActions : existing?.availableActions,
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
    if (!isAuthoritative) {
      return mergeJobPatch(existing, job)
    }
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
    const existing = detail.value?.id === job.id ? detail.value : idx >= 0 ? jobs.value[idx] : null
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
      await apiReady
      const res = await jobsApi.fetchJobs(statusFilter.value, 1, 50, searchQuery.value)
      if (token !== loadJobsToken) return
      const currentById = new Map(jobs.value.map((job) => [job.id, job] as const))
      jobs.value = res.data.jobs
        .map((job) => mergeIncomingJob(currentById.get(job.id), job))
        .filter((job): job is ThreadJob => job !== null)
      total.value = res.data.total
      syncListHubWatches()
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
      await apiReady
      const res = await jobsApi.fetchJob(jobId)
      if (token !== loadDetailToken) return
      applyJobPatch(res.data.job)
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

  function syncHubWatch(): void {
    hubRelease?.()
    hubRelease = null
    const jobId = selectedJobId.value
    const status = selectedJob.value?.status
    if (!jobId || !status || !jobNeedsRealtimeWatch(status)) return
    hubRelease = hub.watchJob(jobId, (event) => handleHubEvent(jobId, event))
  }

  function handleHubEvent(_jobId: string, event: JobSseEvent): void {
    if (event.event === 'job_snapshot' || event.event === 'job_done') {
      applyJobPatch(event.data.job as ThreadJob)
      if (event.event === 'job_done') {
        syncHubWatch()
        debouncedRefreshJobs()
      }
      return
    }
    if (event.event === 'plan_progress' && selectedJob.value) {
      applyJobPatch({
        ...selectedJob.value,
        planProgress: event.data.planProgress
      } as ThreadJob)
    }
    if (event.event === 'task_progress' && selectedJob.value) {
      applyJobPatch({
        ...selectedJob.value,
        taskProgress: event.data.taskProgress
      } as ThreadJob)
    }
  }

  function syncListHubWatches(): void {
    const desired = new Set(
      jobs.value.filter((job) => jobNeedsRealtimeWatch(job.status)).map((job) => job.id)
    )
    for (const [jobId, release] of hubListReleases) {
      if (desired.has(jobId)) continue
      release()
      hubListReleases.delete(jobId)
    }
    for (const jobId of desired) {
      if (hubListReleases.has(jobId)) continue
      hubListReleases.set(
        jobId,
        hub.watchJob(jobId, () => {
          debouncedRefreshJobs()
          if (selectedJobId.value === jobId) {
            debouncedRefreshSelectedDetail(jobId)
          }
        })
      )
    }
  }

  function startHubPolling(): void {
    void apiReady.then(() => {
      syncListHubWatches()
      pollTimer = setInterval(() => {
        if (!hub.connected.value) {
          void loadJobs({ silent: true })
          const jobId = selectedJobId.value
          if (jobId) void loadDetail(jobId, { silent: true })
        }
      }, 30_000)
    })
  }

  function stopHubPolling(): void {
    for (const release of hubListReleases.values()) release()
    hubListReleases.clear()
    hubRelease?.()
    hubRelease = null
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

  watch(
    () => selectedJob.value?.status,
    () => syncHubWatch()
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
        toast.warning('任务状态已变化，请确认后重试')
        return
      }
      toastError(err, 'Action failed')
    } finally {
      runningAction.value = null
    }
  }

  async function handlePause(): Promise<void> {
    await runAction('pause', (job, idempotencyKey) =>
      jobsApi.pause(job.id, requireCommandRevision(job), idempotencyKey)
    )
  }

  async function handleContinue(): Promise<void> {
    await runAction('continue', (job, idempotencyKey) =>
      jobsApi.continue(job.id, requireCommandRevision(job), idempotencyKey)
    )
  }

  async function handleRestart(): Promise<void> {
    await runAction('restart_execution', (job, idempotencyKey) =>
      jobsApi.restartExecution(job.id, requireCommandRevision(job), idempotencyKey)
    )
  }

  async function handleCancel(): Promise<void> {
    await runAction('cancel', (job, idempotencyKey) =>
      jobsApi.cancel(job.id, requireCommandRevision(job), 'user_cancelled', idempotencyKey)
    )
  }

  async function handleDelete(): Promise<void> {
    const job = selectedJob.value
    if (!job) return
    if (!jobsApi.delete) {
      toast.error('Deleting V3 jobs is not supported by the control-plane API')
      return
    }
    // Skip runAction — it reloads detail after success and 404s on a deleted job.
    runningAction.value = 'delete'
    actionError.value = null
    error.value = null
    try {
      await apiReady
      await jobsApi.delete(job.id)
      detail.value = null
      jobs.value = jobs.value.filter((item) => item.id !== job.id)
      total.value = Math.max(0, total.value - 1)
      await router.replace({ name: 'tasks' })
      await loadJobs({ silent: true })
    } catch (err) {
      toastError(err, 'Failed to delete')
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
