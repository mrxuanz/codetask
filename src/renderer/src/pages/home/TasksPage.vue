<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useDebounceFn } from '@vueuse/core'
import { type ThreadJob } from '@renderer/api/jobs'
import Button from '@renderer/components/ui/Button.vue'
import Dialog from '@renderer/components/ui/Dialog.vue'
import TaskParameterPanel from '@renderer/components/tasks/TaskParameterPanel.vue'
import TaskProgressBar from '@renderer/components/tasks/TaskProgressBar.vue'
import TaskProgressTree from '@renderer/components/tasks/TaskProgressTree.vue'
import Card from '@renderer/components/ui/Card.vue'
import CardContent from '@renderer/components/ui/CardContent.vue'
import ErrorAlert from '@renderer/components/ui/ErrorAlert.vue'
import {
  buildPlanTree,
  formatJobTimestamp,
  getExecutionProgressSnapshot,
  getJobProgressSnapshot,
  getPlanProgressSnapshot,
  jobCliSummary,
  jobStatusClass,
  jobStatusLabel,
  resolveJobListStatusBadge,
  type JobProgressSnapshot,
  type UnifiedTaskNode
} from '@renderer/lib/jobProgress'
import { jobHasAction } from '@shared/job-recovery-state'
import { formatTurnError } from '@renderer/i18n/formatTurnError'
import { useJobsStore } from '@renderer/composables/useJobsStore'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()

const selectedJobId = computed(() => (route.params.jobId as string) || null)
const store = useJobsStore({ selectedJobId })

const {
  statusFilter,
  searchQuery,
  jobs,
  total,
  loadingList,
  loadingDetail,
  error,
  actionError,
  runningAction,
  selectedJob
} = store

const selectedTask = ref<UnifiedTaskNode | null>(null)
const taskParametersOpen = ref(false)

const statusFilters = computed(() => [
  { value: 'all', label: t('workspace.tasks.filters.all') },
  { value: 'running', label: t('workspace.tasks.filters.running') },
  { value: 'paused', label: t('workspace.tasks.filters.paused') },
  { value: 'failed', label: t('workspace.tasks.filters.failed') },
  { value: 'completed', label: t('workspace.tasks.filters.completed') },
  { value: 'cancelled', label: t('workspace.tasks.filters.cancelled') }
])

const listProgress = (job: ThreadJob): JobProgressSnapshot => getJobProgressSnapshot(job, t)
const listStatusBadge = (job: ThreadJob): { label: string; className: string } =>
  resolveJobListStatusBadge(job.status, t, job)

const executionProgress = computed(() => getExecutionProgressSnapshot(selectedJob.value, t))
const planProgress = computed(() => getPlanProgressSnapshot(selectedJob.value, t))
const showExecutionProgress = computed(
  () =>
    selectedJob.value?.status === 'running' ||
    selectedJob.value?.status === 'completed' ||
    selectedJob.value?.status === 'failed' ||
    selectedJob.value?.status === 'cancelled' ||
    selectedJob.value?.status === 'paused'
)
const showPlanProgress = computed(
  () =>
    selectedJob.value?.status === 'planning' ||
    selectedJob.value?.status === 'plan_editing'
)

const standaloneLastError = computed(() => {
  const err = selectedJob.value?.lastError
  const formatted = formatTurnError(err, t)?.trim()
  if (!formatted) return null
  if (showExecutionProgress.value && executionProgress.value.summaryLabel === formatted) return null
  if (showPlanProgress.value && planProgress.value.summaryLabel === formatted) return null
  return formatted
})

const planTree = computed(() => buildPlanTree(selectedJob.value, t))
const activeTaskId = computed(() => selectedJob.value?.taskProgress?.currentTaskId ?? null)

const hasAction = (action: string): boolean => jobHasAction(selectedJob.value, action as never)

const canPause = computed(() => hasAction('pause'))
const canContinue = computed(() => hasAction('continue'))
const canRestart = computed(() => hasAction('restart'))
const canDelete = computed(() => hasAction('delete'))

function selectJob(jobId: string): void {
  selectedTask.value = null
  taskParametersOpen.value = false
  void router.push({ name: 'task-detail', params: { jobId } })
}

function handleSelectTask(task: UnifiedTaskNode): void {
  selectedTask.value = task
  taskParametersOpen.value = true
}

function closeTaskParameters(): void {
  taskParametersOpen.value = false
}

onMounted(() => {
  void store.loadJobs()
  store.startHubPolling()
})

onUnmounted(() => {
  store.stopHubPolling()
})

watch(statusFilter, () => void store.loadJobs())

const debouncedSearch = useDebounceFn(() => void store.loadJobs(), 300)
watch(searchQuery, () => void debouncedSearch())
</script>

<template>
  <div class="flex h-full min-h-0 min-w-0 flex-1 overflow-hidden bg-background">
    <div
      class="flex w-72 min-w-[12rem] max-w-[22rem] shrink flex-col overflow-hidden border-r border-border max-lg:max-w-none max-lg:flex-1"
      :class="selectedJobId ? 'max-lg:hidden' : ''"
    >
      <div class="shrink-0 border-b border-border px-4 py-4">
        <h1 class="text-sm font-semibold">{{ t('workspace.tasks.title') }}</h1>
        <p class="mt-1 text-xs text-muted-foreground">
          {{ t('workspace.tasks.total', { count: total }) }}
        </p>
        <input
          v-model="searchQuery"
          type="search"
          class="mt-3 w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring"
          :placeholder="t('workspace.tasks.searchPlaceholder')"
        />
        <div class="mt-3 -mx-1 overflow-x-auto px-1">
          <div class="flex w-max min-w-full gap-2">
            <button
              v-for="filter in statusFilters"
              :key="filter.value"
              type="button"
              class="shrink-0 rounded-md px-2.5 py-1 text-xs transition-colors"
              :class="
                statusFilter === filter.value
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted text-muted-foreground hover:bg-muted/80'
              "
              @click="statusFilter = filter.value"
            >
              {{ filter.label }}
            </button>
          </div>
        </div>
      </div>

      <div class="min-h-0 flex-1 overflow-y-auto p-2">
        <p v-if="loadingList && jobs.length === 0" class="px-2 py-2 text-sm text-muted-foreground">
          {{ t('workspace.loading') }}
        </p>
        <div
          v-else-if="jobs.length === 0"
          class="rounded-md border border-dashed border-border px-4 py-6 text-sm text-muted-foreground"
        >
          {{ searchQuery.trim() ? t('workspace.tasks.searchEmpty') : t('workspace.tasks.empty') }}
        </div>
        <div v-else class="space-y-2">
          <button
            v-for="job in jobs"
            :key="job.id"
            type="button"
            class="w-full rounded-md border px-3 py-3 text-left transition-colors"
            :class="
              job.id === selectedJobId
                ? 'border-foreground/20 bg-muted'
                : 'border-transparent hover:border-border hover:bg-muted/60'
            "
            @click="selectJob(job.id)"
          >
            <div class="flex items-start justify-between gap-3">
              <div class="min-w-0">
                <p class="truncate text-sm font-medium">{{ job.title }}</p>
                <p class="mt-1 line-clamp-2 text-xs text-muted-foreground">
                  {{ job.summary || job.title }}
                </p>
              </div>
              <div class="flex shrink-0 flex-col items-end gap-1">
                <span
                  class="rounded-md px-2 py-0.5 text-[11px] font-medium"
                  :class="listStatusBadge(job).className"
                >
                  {{ listStatusBadge(job).label }}
                </span>
              </div>
            </div>
            <div class="mt-3">
              <TaskProgressBar :snapshot="listProgress(job)" compact />
            </div>
            <div class="mt-2 flex items-center justify-between text-[11px] text-muted-foreground">
              <span>{{ listProgress(job).summaryLabel }}</span>
              <span>{{ formatJobTimestamp(job.updatedAt) }}</span>
            </div>
            <div class="mt-1 truncate text-[11px] text-muted-foreground">
              {{ t('workspace.tasks.cliLabel', { summary: jobCliSummary(job) }) }}
            </div>
          </button>
        </div>
      </div>
    </div>

    <div
      class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
      :class="!selectedJobId ? 'max-lg:hidden' : ''"
    >
      <div v-if="error || actionError" class="shrink-0 space-y-2 px-4 pt-4 sm:px-6">
        <ErrorAlert v-if="error" :message="error" />
        <ErrorAlert v-if="actionError" :message="actionError" />
      </div>

      <div
        v-if="!selectedJob"
        class="flex min-h-0 flex-1 items-center justify-center text-sm text-muted-foreground"
      >
        {{ t('workspace.tasks.selectHint') }}
      </div>

      <div v-else class="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4 sm:p-6">
        <div class="flex flex-col gap-4">
          <Button
            type="button"
            variant="outline"
            size="sm"
            class="shrink-0 self-start lg:hidden"
            @click="router.push({ name: 'tasks' })"
          >
            {{ t('workspace.tasks.backToList') }}
          </Button>

          <Card>
            <CardContent class="space-y-4 p-4 sm:p-6">
              <div class="flex flex-wrap items-start justify-between gap-4">
                <div class="min-w-0">
                  <h1 class="text-xl font-semibold">{{ selectedJob.title }}</h1>
                  <p class="mt-2 text-sm text-muted-foreground">
                    {{ selectedJob.summary || selectedJob.title }}
                  </p>
                </div>
                <div class="flex flex-wrap items-center gap-2">
                  <span
                    class="rounded-md px-2.5 py-1 text-xs font-medium"
                    :class="jobStatusClass(selectedJob.status)"
                  >
                    {{ jobStatusLabel(selectedJob.status, t, selectedJob) }}
                  </span>
                  <Button
                    v-if="canPause"
                    size="sm"
                    variant="outline"
                    :disabled="runningAction === 'pause'"
                    @click="store.handlePause()"
                  >
                    {{ t('workspace.tasks.actions.pause') }}
                  </Button>
                  <Button
                    v-if="canContinue"
                    size="sm"
                    variant="outline"
                    :disabled="runningAction === 'continue'"
                    @click="store.handleContinue()"
                  >
                    {{ t('workspace.tasks.actions.continue') }}
                  </Button>
                  <Button
                    v-if="canRestart"
                    size="sm"
                    variant="outline"
                    :disabled="runningAction === 'restart'"
                    @click="store.handleRestart()"
                  >
                    {{ t('workspace.tasks.actions.restart') }}
                  </Button>
                  <Button
                    v-if="canDelete"
                    size="sm"
                    variant="outline"
                    :disabled="runningAction === 'delete'"
                    @click="store.handleDelete()"
                  >
                    {{ t('workspace.tasks.actions.delete') }}
                  </Button>
                </div>
              </div>

              <div v-if="showPlanProgress" class="space-y-1">
                <p class="text-[11px] font-semibold uppercase text-muted-foreground">
                  {{ t('workspace.tasks.progress.planLabel') }}
                </p>
                <TaskProgressBar :snapshot="planProgress" />
              </div>

              <div v-if="showExecutionProgress" class="space-y-1">
                <p class="text-[11px] font-semibold uppercase text-muted-foreground">
                  {{ t('workspace.tasks.progress.executionLabel') }}
                </p>
                <TaskProgressBar :snapshot="executionProgress" />
              </div>

              <p v-if="standaloneLastError" class="text-xs text-destructive">
                {{ standaloneLastError }}
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardContent class="p-4 sm:p-6">
              <h2 class="mb-3 text-sm font-semibold">
                {{ t('workspace.tasks.executionTree') }}
                <span v-if="loadingDetail" class="text-muted-foreground">
                  · {{ t('workspace.loading') }}
                </span>
              </h2>
              <TaskProgressTree
                :milestones="planTree"
                :job-status="selectedJob.status"
                :abilities="selectedJob.abilities"
                :selected-task-id="selectedTask?.id ?? null"
                :active-task-id="activeTaskId"
                @select-task="handleSelectTask"
              />
            </CardContent>
          </Card>
        </div>
      </div>
    </div>

    <Dialog
      :open="taskParametersOpen"
      class="flex max-h-[min(85vh,640px)] max-w-2xl flex-col"
      @close="closeTaskParameters"
    >
      <div class="shrink-0 border-b border-border px-4 py-3">
        <h2 class="text-base font-semibold">{{ t('workspace.tasks.taskParameters') }}</h2>
        <p v-if="selectedTask" class="mt-1 truncate text-sm text-muted-foreground">
          {{ selectedTask.title }}
        </p>
      </div>
      <div class="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4">
        <TaskParameterPanel
          :task="selectedTask"
          :thread-id="selectedJob?.threadId"
          :job-id="selectedJob?.id"
          :abilities="selectedJob?.abilities"
        />
      </div>
      <div class="flex shrink-0 justify-end border-t border-border px-4 py-3">
        <Button type="button" variant="outline" @click="closeTaskParameters">
          {{ t('folderPicker.close') }}
        </Button>
      </div>
    </Dialog>
  </div>
</template>
