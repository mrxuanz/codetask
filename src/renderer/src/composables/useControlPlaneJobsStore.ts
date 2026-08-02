/**
 * Production Tasks store (C10–C13).
 *
 * - List/detail load `/api/jobs` Execution snapshots.
 * - Server `availableActions` is authoritative (no recovery补算).
 * - Commands use `/api/jobs` with expectedRevision + idempotencyKey.
 * - Realtime: single window RealtimeGateway (`/api/realtime`).
 */
import { computed, ref, watch, type ComputedRef, type Ref } from 'vue'
import { useRouter } from 'vue-router'
import { useDebounceFn } from '@vueuse/core'
import type { ExecutionJob } from '@renderer/api/jobs'
import {
  newIdempotencyKey,
  resolveJobsApi,
  type JobsApi
} from '@renderer/api/jobs-api'
import { ApiError } from '@renderer/api/client'
import { JobsStore } from '@renderer/stores/jobs-store'
import {
  canCancel,
  canDelete,
  filterActions,
  getPauseButtonText
} from '@renderer/stores/ui-actions'
import { toast, toastError } from '@renderer/lib/toast'
import { useRealtimeGateway } from '@renderer/composables/useRealtimeGateway'
import type { RealtimeEnvelope } from '@codetask/contracts'
import { jobNeedsRealtimeWatch } from '@shared/job-realtime'

export interface UseControlPlaneJobsStoreOptions {
  selectedJobId: Ref<string | null>
}

function actionsFor(job: ExecutionJob | null): readonly string[] {
  if (!job?.availableActions) return []
  return filterActions(job.availableActions, { state: jobState(job) })
}

function jobState(job: ExecutionJob): string {
  return job.state
}

function isRevisionConflict(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.httpStatus === 409 &&
    (error.code === 'job.revision_conflict' || error.code === 'execution.conflict')
  )
}

export function useControlPlaneJobsStore(options: UseControlPlaneJobsStoreOptions): {
  statusFilter: Ref<string>
  searchQuery: Ref<string>
  jobs: Ref<ExecutionJob[]>
  total: Ref<number>
  loadingList: Ref<boolean>
  loadingDetail: Ref<boolean>
  error: Ref<string | null>
  actionError: Ref<string | null>
  runningAction: Ref<string | null>
  detail: Ref<ExecutionJob | null>
  selectedJob: ComputedRef<ExecutionJob | null>
  loadJobs: () => Promise<void>
  loadDetail: (id: string) => Promise<void>
  applyJobPatch: (job: ExecutionJob) => void
  startRealtimePolling: () => void
  stopRealtimePolling: () => void
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
  const realtime = useRealtimeGateway()
  const v3Store = new JobsStore()
  const jobsApi: JobsApi = resolveJobsApi()

  function requireRevision(job: ExecutionJob): number {
    if (typeof job.stateRevision !== 'number') {
      throw new Error('Execution job is missing its state revision')
    }
    return job.stateRevision
  }

  const statusFilter = ref('all')
  const searchQuery = ref('')
  const jobs = ref<ExecutionJob[]>([])
  const total = ref(0)
  const loadingList = ref(true)
  const loadingDetail = ref(false)
  const error = ref<string | null>(null)
  const actionError = ref<string | null>(null)
  const runningAction = ref<string | null>(null)
  const detail = ref<ExecutionJob | null>(null)

  let pollTimer: ReturnType<typeof setInterval> | null = null
  let selectedJobWatchRelease: (() => void) | null = null
  const jobWatchReleases = new Map<string, () => void>()
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
  const canRestart = computed(() => selectedActions.value.includes('restart'))
  const canCancelAction = computed(() => canCancel(selectedActions.value))
  const canDeleteAction = computed(() => {
    const job = selectedJob.value
    if (!job) return false
    return (
      canDelete(selectedActions.value) &&
      !['running', 'pausing', 'cancelling', 'queued'].includes(job.state)
    )
  })
  const pauseButtonText = computed(() =>
    selectedJob.value ? getPauseButtonText({ state: selectedJob.value.state }) : null
  )

  function mergeJobPatch(existing: ExecutionJob | null | undefined, job: ExecutionJob): ExecutionJob {
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
    } as ExecutionJob
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
    existing: ExecutionJob | null | undefined,
    job: ExecutionJob
  ): ExecutionJob | null {
    const stateRevision = requireRevision(job)
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

  function applyJobPatch(job: ExecutionJob): void {
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
      const res = await jobsApi.fetchJobs(statusFilter.value, 1, 50, searchQuery.value)
      if (token !== loadJobsToken) return
      const currentById = new Map(jobs.value.map((job) => [job.id, job] as const))
      jobs.value = res.data.jobs
        .map((job) => mergeIncomingJob(currentById.get(job.id), job))
        .filter((job): job is ExecutionJob => job !== null)
      total.value = res.data.total
      syncListRealtimeWatches()
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
      const res = await jobsApi.fetchJob(jobId)
      if (token !== loadDetailToken) return
      applyJobPatch(res.data.job)
      syncRealtimeWatch()
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

  function syncRealtimeWatch(): void {
    selectedJobWatchRelease?.()
    selectedJobWatchRelease = null
    const jobId = selectedJobId.value
    const state = selectedJob.value?.state
    if (!jobId || !state || !jobNeedsRealtimeWatch(state)) return
    selectedJobWatchRelease = realtime.watchJob(jobId, (event) => handleRealtimeEvent(jobId, event))
  }

  function handleRealtimeEvent(_jobId: string, event: RealtimeEnvelope): void {
    // Minimal durable events no longer carry full JobDetail — always HTTP resync.
    if (
      event.type === 'job.changed' ||
      event.type === 'job.completed' ||
      event.type === 'job.queue.changed' ||
      event.type === 'job.run.changed' ||
      event.type === 'work.changed' ||
      event.type === 'verification.changed' ||
      event.type === 'repair.created' ||
      event.type === 'job.deleted'
    ) {
      scheduleResync(_jobId)
      if (event.type === 'job.completed' || event.type === 'job.deleted') {
        syncRealtimeWatch()
      }
    }
  }

  function syncListRealtimeWatches(): void {
    const desired = new Set(
      jobs.value.filter((job) => jobNeedsRealtimeWatch(job.state)).map((job) => job.id)
    )
    for (const [jobId, release] of jobWatchReleases) {
      if (desired.has(jobId)) continue
      release()
      jobWatchReleases.delete(jobId)
    }
    for (const jobId of desired) {
      if (jobWatchReleases.has(jobId)) continue
      jobWatchReleases.set(
        jobId,
        realtime.watchJob(jobId, () => {
          debouncedRefreshJobs()
          if (selectedJobId.value === jobId) {
            debouncedRefreshSelectedDetail(jobId)
          }
        })
      )
    }
  }

  function startRealtimePolling(): void {
    syncListRealtimeWatches()
    pollTimer = setInterval(() => {
      if (!realtime.connected.value) {
        void loadJobs({ silent: true })
        const jobId = selectedJobId.value
        if (jobId) void loadDetail(jobId, { silent: true })
      }
    }, 30_000)
  }

  function stopRealtimePolling(): void {
    for (const release of jobWatchReleases.values()) release()
    jobWatchReleases.clear()
    selectedJobWatchRelease?.()
    selectedJobWatchRelease = null
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
        selectedJobWatchRelease?.()
        selectedJobWatchRelease = null
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
    () => selectedJob.value?.state,
    () => syncRealtimeWatch()
  )

  async function runAction(
    action: string,
    fn: (job: ExecutionJob, idempotencyKey: string) => Promise<unknown>
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
      jobsApi.pause(job.id, requireRevision(job), idempotencyKey)
    )
  }

  async function handleContinue(): Promise<void> {
    await runAction('continue', (job, idempotencyKey) =>
      jobsApi.continue(job.id, requireRevision(job), idempotencyKey)
    )
  }

  async function handleRestart(): Promise<void> {
    await runAction('restart', (job, idempotencyKey) =>
      jobsApi.restartExecution(job.id, requireRevision(job), idempotencyKey)
    )
  }

  async function handleCancel(): Promise<void> {
    await runAction('cancel', (job, idempotencyKey) =>
      jobsApi.cancel(job.id, requireRevision(job), 'user_cancelled', idempotencyKey)
    )
  }

  async function handleDelete(): Promise<void> {
    const job = selectedJob.value
    if (!job || !jobsApi.delete) return
    runningAction.value = 'delete'
    actionError.value = null
    error.value = null
    try {
      await jobsApi.delete(job.id, requireRevision(job), newIdempotencyKey())
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
    startRealtimePolling,
    stopRealtimePolling,
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
