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
import { useI18n } from 'vue-i18n'
import { useDebounceFn } from '@vueuse/core'
import type { ExecutionJob } from '@renderer/api/jobs'
import { newIdempotencyKey, resolveJobsApi, type JobsApi } from '@renderer/api/jobs-api'
import { ApiError } from '@renderer/api/client'
import type { ApiSuccess } from '@renderer/api/types'
import {
  canCancel,
  canDelete,
  filterActions,
  getPauseButtonText
} from '@renderer/stores/ui-actions'
import { toast, toastError } from '@renderer/lib/toast'
import { mergeExecutionJobSnapshot } from '@renderer/lib/mergeExecutionJob'
import { useRealtimeGateway } from '@renderer/composables/useRealtimeGateway'
import type { RealtimeEnvelope } from '@codetask/contracts'
import { jobNeedsRealtimeWatch } from '@codetask/contracts/job-realtime'

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
  page: Ref<number>
  totalPages: ComputedRef<number>
  loadingList: Ref<boolean>
  loadingDetail: Ref<boolean>
  error: Ref<string | null>
  runningAction: Ref<string | null>
  detail: Ref<ExecutionJob | null>
  selectedJob: ComputedRef<ExecutionJob | null>
  loadJobs: () => Promise<void>
  goToPage: (page: number) => Promise<void>
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
} {
  const { selectedJobId } = options
  const router = useRouter()
  const { t } = useI18n()
  const realtime = useRealtimeGateway()
  const jobsApi: JobsApi = resolveJobsApi()
  const pageSize = 50

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
  const page = ref(1)
  const totalPages = computed(() => Math.max(1, Math.ceil(total.value / pageSize)))
  const loadingList = ref(true)
  const loadingDetail = ref(false)
  const error = ref<string | null>(null)
  const runningAction = ref<string | null>(null)
  const detail = ref<ExecutionJob | null>(null)

  let pollTimer: ReturnType<typeof setInterval> | null = null
  let selectedJobWatchRelease: (() => void) | null = null
  const jobWatchReleases = new Map<string, () => void>()
  let loadDetailToken = 0
  let loadJobsToken = 0

  const selectedJob = computed(() => {
    const jobId = selectedJobId.value
    if (!jobId) return null
    if (detail.value?.id === jobId) return detail.value
    return jobs.value.find((job) => job.id === jobId) ?? null
  })

  const selectedActions = computed(() => actionsFor(selectedJob.value))

  const actionsReady = computed(
    () =>
      !loadingDetail.value &&
      runningAction.value === null &&
      selectedJob.value?.id === selectedJobId.value
  )
  const canPause = computed(() => actionsReady.value && selectedActions.value.includes('pause'))
  const canContinue = computed(
    () => actionsReady.value && selectedActions.value.includes('continue')
  )
  const canRestart = computed(() => actionsReady.value && selectedActions.value.includes('restart'))
  const canCancelAction = computed(() => actionsReady.value && canCancel(selectedActions.value))
  const canDeleteAction = computed(() => {
    const job = selectedJob.value
    if (!job) return false
    return actionsReady.value && canDelete(selectedActions.value)
  })
  const pauseButtonText = computed(() =>
    selectedJob.value ? getPauseButtonText({ state: selectedJob.value.state }) : null
  )

  function mergeIncomingJob(
    existing: ExecutionJob | null | undefined,
    job: ExecutionJob
  ): ExecutionJob | null {
    return mergeExecutionJobSnapshot(existing, job)
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
      const res = await jobsApi.fetchJobs(
        statusFilter.value,
        page.value,
        pageSize,
        searchQuery.value
      )
      if (token !== loadJobsToken) return
      const currentById = new Map(jobs.value.map((job) => [job.id, job] as const))
      if (detail.value) currentById.set(detail.value.id, detail.value)
      jobs.value = res.data.jobs
        .map((job) => mergeIncomingJob(currentById.get(job.id), job))
        .filter((job): job is ExecutionJob => job !== null)
      total.value = res.data.total
      page.value = res.data.page
      syncListRealtimeWatches()
    } catch (err) {
      if (!silent) {
        error.value = err instanceof Error ? err.message : t('workspace.tasks.loadFailed')
      }
    } finally {
      if (!silent && token === loadJobsToken) loadingList.value = false
    }
  }

  async function goToPage(nextPage: number): Promise<void> {
    const normalized = Math.min(Math.max(1, nextPage), totalPages.value)
    if (normalized === page.value) return
    page.value = normalized
    await loadJobs()
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
      if (err instanceof ApiError && err.httpStatus === 404 && selectedJobId.value === jobId) {
        detail.value = null
        await router.replace({ name: 'tasks' })
        return
      }
      if (!silent) {
        error.value = err instanceof Error ? err.message : t('workspace.tasks.detailFailed')
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
      event.type === 'job.submitted' ||
      event.type === 'job.started' ||
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
      if (event.type === 'job.deleted' && selectedJobId.value === _jobId) {
        detail.value = null
        void router.replace({ name: 'tasks' })
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

  watch(statusFilter, () => {
    page.value = 1
    void loadJobs()
  })
  const debouncedSearch = useDebounceFn(() => void loadJobs(), 300)
  watch(searchQuery, () => {
    page.value = 1
    void debouncedSearch()
  })

  watch(
    selectedJobId,
    (jobId, prevJobId) => {
      if (jobId !== prevJobId) {
        selectedJobWatchRelease?.()
        selectedJobWatchRelease = null
        detail.value = null
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
    fn: (job: ExecutionJob, idempotencyKey: string) => Promise<ApiSuccess<{ job: ExecutionJob }>>
  ): Promise<void> {
    const job = selectedJob.value
    if (
      !job ||
      loadingDetail.value ||
      runningAction.value !== null ||
      job.id !== selectedJobId.value ||
      !actionsFor(job).includes(action)
    ) {
      return
    }
    runningAction.value = action
    const idempotencyKey = newIdempotencyKey()
    try {
      const result = await fn(job, idempotencyKey)
      applyJobPatch(result.data.job)
      await loadJobs({ silent: true })
    } catch (err) {
      if (isRevisionConflict(err)) {
        if (selectedJobId.value === job.id) await loadDetail(job.id)
        else await loadJobs({ silent: true })
        toast.warning(t('workspace.tasks.revisionConflict'))
        return
      }
      toastError(err, t('workspace.tasks.actionFailed'))
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
      jobsApi.continue(
        job.id,
        requireRevision(job),
        idempotencyKey,
        job.recoveryReason === 'uncertain_provider_outcome' ||
          job.recoveryReason === 'restart_interrupted' ||
          job.recoveryReason === 'migration_ambiguous'
      )
    )
  }

  async function handleRestart(): Promise<void> {
    await runAction('restart', (job, idempotencyKey) =>
      jobsApi.restartExecution(job.id, requireRevision(job), idempotencyKey)
    )
  }

  async function handleCancel(): Promise<void> {
    await runAction('cancel', (job, idempotencyKey) =>
      jobsApi.cancel(job.id, requireRevision(job), idempotencyKey)
    )
  }

  async function handleDelete(): Promise<void> {
    const job = selectedJob.value
    if (
      !job ||
      !jobsApi.delete ||
      runningAction.value !== null ||
      loadingDetail.value ||
      job.id !== selectedJobId.value ||
      !actionsFor(job).includes('delete')
    ) {
      return
    }
    runningAction.value = 'delete'
    error.value = null
    try {
      await jobsApi.delete(job.id, requireRevision(job), newIdempotencyKey())
      const stillSelected = selectedJobId.value === job.id
      if (stillSelected) detail.value = null
      jobs.value = jobs.value.filter((item) => item.id !== job.id)
      total.value = Math.max(0, total.value - 1)
      page.value = Math.min(page.value, totalPages.value)
      if (stillSelected) await router.replace({ name: 'tasks' })
      await loadJobs({ silent: true })
    } catch (err) {
      if (isRevisionConflict(err)) {
        if (selectedJobId.value === job.id) await loadDetail(job.id)
        else await loadJobs({ silent: true })
        toast.warning(t('workspace.tasks.revisionConflict'))
        return
      }
      toastError(err, t('workspace.tasks.deleteFailed'))
    } finally {
      runningAction.value = null
    }
  }

  return {
    statusFilter,
    searchQuery,
    jobs,
    total,
    page,
    totalPages,
    loadingList,
    loadingDetail,
    error,
    runningAction,
    detail,
    selectedJob,
    loadJobs,
    goToPage,
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
    pauseButtonText
  }
}
