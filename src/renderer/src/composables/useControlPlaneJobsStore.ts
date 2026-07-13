/**
 * Production Tasks store (C10–C13).
 *
 * - List/detail still load legacy ThreadJob for progress projections.
 * - Actions prefer server `availableActions` (no recovery补算).
 * - When `stateRevision` is present, commands go through `/api/v3`.
 */
import { computed, ref, watch, type ComputedRef, type Ref } from 'vue'
import { useRouter } from 'vue-router'
import { useDebounceFn } from '@vueuse/core'
import {
  fetchJobs,
  fetchJob,
  pauseJob,
  continueJob,
  resumeJob,
  restartJob,
  deleteJob,
  type ThreadJob
} from '@renderer/api/jobs'
import {
  pauseV3Job,
  continueV3Job,
  cancelV3Job,
  restartExecutionV3Job
} from '@renderer/api/v3-jobs'
import { jobNeedsRealtimeWatch } from '@shared/job-realtime'
import { useJobEventHub } from '@renderer/composables/useJobEventHub'
import type { JobSseEvent } from '@renderer/api/jobs'
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
  let loadDetailToken = 0

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

  function applyJobPatch(job: ThreadJob): void {
    if (job.stateRevision !== undefined && job.availableActions) {
      v3Store.mergeJob(
        {
          id: job.id,
          state: mapLegacyStatusToState(job.status),
          stateRevision: job.stateRevision,
          availableActions: job.availableActions
        },
        'authoritative_snapshot'
      )
    }
    if (detail.value?.id === job.id) {
      detail.value = mergeJobPatch(detail.value, job)
    } else if (selectedJobId.value === job.id) {
      detail.value = mergeJobPatch(detail.value, job)
    }
    const idx = jobs.value.findIndex((item) => item.id === job.id)
    if (idx >= 0) {
      jobs.value[idx] = mergeJobPatch(jobs.value[idx], job)
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
    const silent = options?.silent ?? false
    if (!silent) loadingList.value = true
    error.value = null
    try {
      const res = await fetchJobs(statusFilter.value, 1, 50, searchQuery.value)
      jobs.value = res.data.jobs
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
      const res = await fetchJob(jobId)
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

  function startHubPolling(): void {
    hubListRelease = hub.onAnyJobEvent((envelope) => {
      if (!envelope.topic.startsWith('job:')) return
      void loadJobs({ silent: true })
    })
    pollTimer = setInterval(() => {
      if (!hub.connected.value) {
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
