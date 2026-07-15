/**
 * @deprecated Prefer `useControlPlaneJobsStore` for production Tasks UI (C13).
 */
import { computed, ref, watch } from 'vue'
import type { ComputedRef, Ref } from 'vue'
import { useRouter } from 'vue-router'
import { useDebounceFn } from '@vueuse/core'
import {
  continueJob,
  deleteJob,
  fetchJob,
  fetchJobs,
  pauseJob,
  restartJob,
  resumeJob,
  type ThreadJob
} from '@renderer/api/jobs'
import type { JobSseEvent } from '@shared/contracts/sse'
import { jobNeedsRealtimeWatch } from '@shared/job-realtime'
import { useJobEventHub } from '@renderer/composables/useJobEventHub'
import { toastError } from '@renderer/lib/toast'

export interface UseJobsStoreOptions {
  selectedJobId: Ref<string | null>
}

export function useJobsStore(options: UseJobsStoreOptions): {
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
  handleDelete: () => Promise<void>
} {
  const { selectedJobId } = options
  const router = useRouter()
  const hub = useJobEventHub()

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
    selectedJobId.value ? detail.value ?? jobs.value.find((j) => j.id === selectedJobId.value) ?? null : null
  )

  function mergeJobPatch(existing: ThreadJob | null | undefined, job: ThreadJob): ThreadJob {
    const has = (key: string): boolean => key in job
    const merged = {
      ...(existing ?? {}),
      ...job,
      plan: has('plan') ? job.plan : (existing?.plan ?? null),
      abilities: has('abilities') ? job.abilities : (existing?.abilities ?? []),
      planProgress: has('planProgress') ? job.planProgress : existing?.planProgress,
      taskProgress: has('taskProgress') ? job.taskProgress : existing?.taskProgress
    } as ThreadJob
    return merged
  }

  function applyJobPatch(job: ThreadJob): void {
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
      if (event.event === 'job_done') {
        syncHubWatch()
      }
      return
    }
    if (event.event === 'plan_progress' && selectedJob.value) {
      const job = { ...selectedJob.value, planProgress: event.data.planProgress }
      applyJobPatch(job)
    }
    if (event.event === 'task_progress' && selectedJob.value) {
      const job = { ...selectedJob.value, taskProgress: event.data.taskProgress }
      applyJobPatch(job)
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

  watch(selectedJobId, (jobId, prevJobId) => {
    if (jobId !== prevJobId) {
      hubRelease?.()
      hubRelease = null
    }
    if (!jobId) {
      detail.value = null
      return
    }
    void loadDetail(jobId)
  }, { immediate: true })

  watch(() => selectedJob.value?.status, () => syncHubWatch())

  async function runAction(
    action: string,
    fn: (jobId: string) => Promise<unknown>
  ): Promise<void> {
    const job = selectedJob.value
    if (!job) return
    runningAction.value = action
    actionError.value = null
    try {
      await fn(job.id)
      await loadDetail(job.id)
    } catch (err) {
      toastError(err, 'Action failed')
    } finally {
      runningAction.value = null
    }
  }

  async function handlePause(): Promise<void> {
    const job = selectedJob.value
    if (!job) return
    runningAction.value = 'pause'
    actionError.value = null
    try {
      await pauseJob(job.id)
      await loadDetail(job.id)
    } catch (err) {
      toastError(err, 'Failed to pause')
    } finally {
      runningAction.value = null
    }
  }

  async function handleContinue(): Promise<void> {
    const job = selectedJob.value
    if (!job) return
    if (job.lifecycle === 'paused' || job.status === 'paused') {
      await runAction('continue', resumeJob)
      return
    }
    await runAction('continue', continueJob)
  }

  async function handleRestart(): Promise<void> {
    await runAction('restart', restartJob)
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
    syncHubWatch,
    startHubPolling,
    stopHubPolling,
    handlePause,
    handleContinue,
    handleRestart,
    handleDelete
  }
}
