<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  FileCheck2,
  Files,
  Gauge,
  Loader2,
  Pause,
  Play,
  RotateCcw,
  ShieldCheck,
  Trash2,
  Wrench
} from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'
import Button from '@renderer/components/ui/Button.vue'
import ErrorAlert from '@renderer/components/ui/ErrorAlert.vue'
import {
  continueJob,
  deleteJob,
  fetchJobSettings,
  fetchJobs,
  pauseJob,
  subscribeJobEvents,
  type JobItemKind,
  type JobItemSnapshot,
  type JobSnapshot,
  type JobState
} from '@renderer/api/jobs'
import { translateApiError } from '@renderer/i18n/translateApiError'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const jobs = ref<JobSnapshot[]>([])
const selectedId = ref<string | null>(null)
const selectedItemId = ref<string | null>(null)
const maxConcurrentJobs = ref<1 | 2>(1)
const loading = ref(true)
const acting = ref(false)
const error = ref<string | null>(null)
const view = ref<'overview' | 'timeline'>('timeline')
const expandedGroups = ref<Set<string>>(new Set())
let unsubscribe: (() => void) | null = null
let refreshTimer: number | null = null

const selected = computed(() => jobs.value.find((job) => job.id === selectedId.value) ?? null)
const selectedItem = computed(
  () => selected.value?.items.find((item) => item.id === selectedItemId.value) ?? null
)
const executionPool = computed(() =>
  jobs.value.filter((job) => job.state === 'running' || job.state === 'pause_requested')
)
const waitingQueue = computed(() =>
  jobs.value
    .filter((job) => job.state === 'queued')
    .sort((left, right) => (left.queuePosition ?? 0) - (right.queuePosition ?? 0))
)
const retained = computed(() =>
  jobs.value.filter(
    (job) => !['running', 'pause_requested', 'queued', 'deleted'].includes(job.state)
  )
)
const progressValue = computed(() => {
  const job = selected.value
  return !job || job.totalItems === 0 ? 0 : Math.round((job.completedItems / job.totalItems) * 100)
})

type ItemGroup = {
  id: string
  title: string
  kind: 'milestone' | 'slice'
  items: JobItemSnapshot[]
}

const itemGroups = computed<ItemGroup[]>(() => {
  const job = selected.value
  if (!job) return []
  const groups: ItemGroup[] = []
  for (const milestone of job.executionTree.milestones) {
    for (const slice of milestone.slices) {
      const scopeIds = new Set([slice.id, ...slice.tasks.map((task) => task.id)])
      const items = job.items.filter(
        (item) =>
          scopeIds.has(item.scopeId) ||
          (item.treeTaskId !== null && scopeIds.has(item.treeTaskId))
      )
      if (items.length > 0) {
        groups.push({
          id: slice.id,
          title: `${milestone.title} / ${slice.title}`,
          kind: 'slice',
          items: items.sort((left, right) => left.sequence - right.sequence)
        })
      }
    }
    const milestoneGate = job.items.filter(
      (item) => item.kind === 'milestone_validation' && item.scopeId === milestone.id
    )
    if (milestoneGate.length > 0) {
      groups.push({
        id: milestone.id,
        title: `${milestone.title} / 里程碑校验`,
        kind: 'milestone',
        items: milestoneGate
      })
    }
  }
  const groupedIds = new Set(groups.flatMap((group) => group.items.map((item) => item.id)))
  const ungrouped = job.items.filter((item) => !groupedIds.has(item.id))
  if (ungrouped.length > 0) {
    groups.push({ id: 'repairs', title: '补充与修复 Work', kind: 'slice', items: ungrouped })
  }
  return groups
})

function stateLabel(state: JobState): string {
  return t(`jobs.states.${state}`)
}

function kindLabel(kind: JobItemKind): string {
  return t(`jobs.kinds.${kind}`)
}

function reportError(cause: unknown): void {
  error.value = translateApiError(cause instanceof Error ? cause.message : String(cause), t)
}

function stateTone(state: JobState): string {
  if (state === 'succeeded') return 'bg-emerald-500/10 text-emerald-700'
  if (state === 'failed') return 'bg-destructive/10 text-destructive'
  if (state === 'running' || state === 'pause_requested') return 'bg-primary/10 text-primary'
  if (state === 'paused') return 'bg-amber-500/10 text-amber-700'
  return 'bg-muted text-muted-foreground'
}

function itemTone(item: JobItemSnapshot): string {
  if (item.state === 'succeeded' || item.state === 'skipped') return 'text-emerald-600'
  if (item.state === 'failed') return 'text-destructive'
  if (item.state === 'running') return 'text-primary'
  return 'text-muted-foreground'
}

function formatTime(value: number | null): string {
  return value ? new Date(value).toLocaleString() : '—'
}

function formatDuration(item: JobItemSnapshot): string {
  if (!item.startedAtMs) return '—'
  const end = item.finishedAtMs ?? Date.now()
  const seconds = Math.max(0, Math.round((end - item.startedAtMs) / 1000))
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}

function toggleGroup(id: string): void {
  const next = new Set(expandedGroups.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  expandedGroups.value = next
}

async function selectJob(id: string): Promise<void> {
  selectedId.value = id
  const job = jobs.value.find((candidate) => candidate.id === id)
  selectedItemId.value = job?.activeItemId ?? job?.items[0]?.id ?? null
  for (const group of itemGroups.value) expandedGroups.value.add(group.id)
  await router.replace(`/home/tasks/${id}`)
}

async function load(preferredId?: string): Promise<void> {
  error.value = null
  try {
    const [jobResult, settingsResult] = await Promise.all([fetchJobs(), fetchJobSettings()])
    jobs.value = jobResult.data
    maxConcurrentJobs.value = settingsResult.data.settings.maxConcurrentJobs
    const routeId = typeof route.params.jobId === 'string' ? route.params.jobId : undefined
    const target =
      jobs.value.find((job) => job.id === preferredId) ??
      jobs.value.find((job) => job.id === routeId) ??
      jobs.value.find((job) => job.id === selectedId.value) ??
      executionPool.value[0] ??
      waitingQueue.value[0] ??
      retained.value[0]
    selectedId.value = target?.id ?? null
    if (target) {
      const currentStillExists = target.items.some((item) => item.id === selectedItemId.value)
      if (!currentStillExists || target.activeItemId) {
        selectedItemId.value = target.activeItemId ?? target.items[0]?.id ?? null
      }
      expandedGroups.value = new Set(itemGroups.value.map((group) => group.id))
      if (routeId !== target.id) await router.replace(`/home/tasks/${target.id}`)
    }
  } catch (cause) {
    reportError(cause)
  } finally {
    loading.value = false
  }
}

function scheduleRefresh(jobId?: string | null): void {
  if (refreshTimer !== null) return
  refreshTimer = window.setTimeout(() => {
    refreshTimer = null
    void load(jobId ?? selectedId.value ?? undefined)
  }, 120)
}

async function act(action: 'pause' | 'continue' | 'delete'): Promise<void> {
  const current = selected.value
  if (!current || acting.value) return
  if (action === 'delete' && !window.confirm(t('jobs.deletePrompt', { title: current.title }))) {
    return
  }
  acting.value = true
  error.value = null
  try {
    if (action === 'pause') await pauseJob(current.id)
    if (action === 'continue') await continueJob(current.id)
    if (action === 'delete') await deleteJob(current.id)
    await load(action === 'delete' ? undefined : current.id)
  } catch (cause) {
    reportError(cause)
  } finally {
    acting.value = false
  }
}

watch(
  () => route.params.jobId,
  (jobId) => {
    if (typeof jobId === 'string' && jobs.value.some((job) => job.id === jobId)) {
      selectedId.value = jobId
    }
  }
)

onMounted(async () => {
  await load()
  unsubscribe = subscribeJobEvents((event) => scheduleRefresh(event.jobId))
})

onUnmounted(() => {
  unsubscribe?.()
  if (refreshTimer !== null) window.clearTimeout(refreshTimer)
})
</script>

<template>
  <div class="flex min-h-0 min-w-0 flex-1 bg-background">
    <aside class="flex w-72 shrink-0 flex-col border-r border-border bg-card/50">
      <div class="border-b border-border px-4 py-3">
        <div class="flex items-center justify-between">
          <div>
            <h1 class="text-sm font-semibold">{{ t('jobs.title') }}</h1>
            <p class="mt-0.5 text-[11px] text-muted-foreground">
              执行池 {{ executionPool.length }}/{{ maxConcurrentJobs }}
            </p>
          </div>
          <Gauge class="size-5 text-muted-foreground" />
        </div>
      </div>
      <div class="min-h-0 flex-1 overflow-y-auto p-3">
        <div v-if="loading" class="flex justify-center p-8">
          <Loader2 class="size-5 animate-spin text-muted-foreground" />
        </div>
        <template v-else>
          <section class="mb-5">
            <h2 class="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              {{ t('jobs.executionPool') }} · {{ executionPool.length }}/{{ maxConcurrentJobs }}
            </h2>
            <p v-if="executionPool.length === 0" class="rounded-lg border border-dashed p-3 text-xs text-muted-foreground">
              {{ t('jobs.poolEmpty') }}
            </p>
            <button
              v-for="job in executionPool"
              :key="job.id"
              type="button"
              class="mb-2 w-full rounded-lg border p-3 text-left transition-colors"
              :class="selectedId === job.id ? 'border-primary/40 bg-primary/10' : 'border-border bg-card hover:bg-muted'"
              @click="selectJob(job.id)"
            >
              <div class="flex items-start gap-2">
                <Loader2 class="mt-0.5 size-4 shrink-0 animate-spin text-primary" />
                <div class="min-w-0 flex-1">
                  <p class="truncate text-sm font-medium">{{ job.title }}</p>
                  <p class="mt-1 text-[11px] text-muted-foreground">{{ job.completedItems }}/{{ job.totalItems }} · {{ stateLabel(job.state) }}</p>
                  <div class="mt-2 h-1 overflow-hidden rounded bg-muted">
                    <div class="h-full bg-primary" :style="{ width: `${job.totalItems ? (job.completedItems / job.totalItems) * 100 : 0}%` }" />
                  </div>
                </div>
              </div>
            </button>
          </section>

          <section class="mb-5">
            <h2 class="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              {{ t('jobs.waitingQueue') }} · {{ waitingQueue.length }}
            </h2>
            <p v-if="waitingQueue.length === 0" class="rounded-lg border border-dashed p-3 text-xs text-muted-foreground">
              {{ t('jobs.queueEmpty') }}
            </p>
            <button
              v-for="job in waitingQueue"
              :key="job.id"
              type="button"
              class="mb-1.5 w-full rounded-lg border px-3 py-2.5 text-left"
              :class="selectedId === job.id ? 'border-primary/40 bg-primary/10' : 'border-transparent hover:bg-muted'"
              @click="selectJob(job.id)"
            >
              <p class="truncate text-sm font-medium">#{{ job.queuePosition }} {{ job.title }}</p>
              <p class="mt-1 text-[11px] text-muted-foreground">{{ job.workspace.title }}</p>
            </button>
          </section>

          <section>
            <h2 class="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              {{ t('jobs.retained') }} · {{ retained.length }}
            </h2>
            <button
              v-for="job in retained"
              :key="job.id"
              type="button"
              class="mb-1.5 w-full rounded-lg border px-3 py-2.5 text-left"
              :class="selectedId === job.id ? 'border-primary/40 bg-primary/10' : 'border-transparent hover:bg-muted'"
              @click="selectJob(job.id)"
            >
              <div class="flex items-center gap-2">
                <CheckCircle2 v-if="job.state === 'succeeded'" class="size-4 shrink-0 text-emerald-600" />
                <AlertTriangle v-else-if="job.state === 'failed'" class="size-4 shrink-0 text-destructive" />
                <Pause v-else class="size-4 shrink-0 text-amber-600" />
                <div class="min-w-0">
                  <p class="truncate text-sm font-medium">{{ job.title }}</p>
                  <p class="mt-0.5 text-[11px] text-muted-foreground">{{ stateLabel(job.state) }} · {{ job.completedItems }}/{{ job.totalItems }}</p>
                </div>
              </div>
            </button>
          </section>
        </template>
      </div>
    </aside>

    <section v-if="!loading && !selected" class="flex flex-1 items-center justify-center p-8">
      <div class="max-w-md text-center">
        <Files class="mx-auto size-10 text-muted-foreground/50" />
        <h2 class="mt-4 text-lg font-semibold">{{ t('jobs.emptyTitle') }}</h2>
        <p class="mt-2 text-sm text-muted-foreground">{{ t('jobs.emptyDescription') }}</p>
        <RouterLink to="/home/create" class="mt-5 inline-flex h-10 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground">
          {{ t('jobs.goDrafts') }}
        </RouterLink>
      </div>
    </section>

    <section v-else-if="selected" class="flex min-h-0 min-w-0 flex-1 flex-col">
      <header class="shrink-0 border-b border-border bg-card px-5 py-4">
        <ErrorAlert v-if="error" class="mb-3" :message="error" />
        <div class="flex flex-wrap items-start justify-between gap-4">
          <div class="min-w-0 flex-1">
            <div class="flex flex-wrap items-center gap-2">
              <h1 class="truncate text-xl font-semibold">{{ selected.title }}</h1>
              <span class="rounded-full px-2.5 py-1 text-xs font-medium" :class="stateTone(selected.state)">
                {{ stateLabel(selected.state) }}
              </span>
              <span v-if="selected.queuePosition" class="rounded-full bg-muted px-2.5 py-1 text-xs">
                队列 #{{ selected.queuePosition }}
              </span>
            </div>
            <p class="mt-1 truncate text-xs text-muted-foreground">
              {{ selected.workspace.title }} · {{ selected.workspace.rootPath }}
            </p>
          </div>
          <div class="flex items-center gap-2">
            <Button
              v-if="selected.state === 'queued' || selected.state === 'running'"
              variant="outline"
              :disabled="acting"
              @click="act('pause')"
            >
              <Pause class="size-4" />{{ t('jobs.pause') }}
            </Button>
            <Button
              v-if="['pause_requested', 'paused', 'failed'].includes(selected.state)"
              :disabled="acting"
              @click="act('continue')"
            >
              <RotateCcw v-if="selected.state === 'failed'" class="size-4" />
              <Play v-else class="size-4" />
              {{ selected.state === 'pause_requested' ? t('jobs.cancelPause') : t('jobs.continue') }}
            </Button>
            <Button variant="outline" :disabled="acting" @click="act('delete')">
              <Trash2 class="size-4" />
            </Button>
          </div>
        </div>
        <div class="mt-4 flex items-center gap-3">
          <div class="h-2 min-w-32 flex-1 overflow-hidden rounded-full bg-muted">
            <div class="h-full bg-primary transition-all" :style="{ width: `${progressValue}%` }" />
          </div>
          <span class="text-xs font-medium">{{ selected.completedItems }}/{{ selected.totalItems }}</span>
        </div>
        <p v-if="selected.lastError" class="mt-3 rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {{ selected.lastError.code }} · {{ selected.lastError.message }}
          <span v-if="selected.state === 'failed'" class="block mt-1 text-xs">
            点击“继续”会把失败位置恢复为待执行，不会重放已成功的 Work。
          </span>
        </p>
        <nav class="mt-4 flex gap-1">
          <button type="button" class="rounded-md px-3 py-1.5 text-xs font-medium" :class="view === 'timeline' ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'" @click="view = 'timeline'">
            执行进度
          </button>
          <button type="button" class="rounded-md px-3 py-1.5 text-xs font-medium" :class="view === 'overview' ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'" @click="view = 'overview'">
            任务参数与执行树
          </button>
        </nav>
      </header>

      <div v-if="view === 'timeline'" class="grid min-h-0 flex-1 grid-cols-[minmax(420px,1fr)_minmax(320px,0.7fr)]">
        <div class="min-h-0 overflow-y-auto border-r border-border p-5">
          <div class="mx-auto max-w-4xl space-y-3">
            <section v-for="group in itemGroups" :key="group.id" class="overflow-hidden rounded-xl border border-border bg-card">
              <button type="button" class="flex w-full items-center gap-2 px-4 py-3 text-left hover:bg-muted/60" @click="toggleGroup(group.id)">
                <ChevronDown v-if="expandedGroups.has(group.id)" class="size-4 text-muted-foreground" />
                <ChevronRight v-else class="size-4 text-muted-foreground" />
                <span class="min-w-0 flex-1 truncate text-sm font-semibold">{{ group.title }}</span>
                <span class="text-xs text-muted-foreground">
                  {{ group.items.filter((item) => ['succeeded', 'skipped'].includes(item.state)).length }}/{{ group.items.length }}
                </span>
              </button>
              <div v-if="expandedGroups.has(group.id)" class="border-t border-border">
                <button
                  v-for="item in group.items"
                  :key="item.id"
                  type="button"
                  class="flex w-full items-start gap-3 border-b border-border/70 px-4 py-3 text-left last:border-b-0"
                  :class="selectedItemId === item.id ? 'bg-primary/5' : 'hover:bg-muted/40'"
                  @click="selectedItemId = item.id"
                >
                  <div class="mt-0.5">
                    <Loader2 v-if="item.state === 'running'" class="size-4 animate-spin text-primary" />
                    <Check v-else-if="item.state === 'succeeded' || item.state === 'skipped'" class="size-4 text-emerald-600" />
                    <AlertTriangle v-else-if="item.state === 'failed'" class="size-4 text-destructive" />
                    <Circle v-else class="size-4 text-muted-foreground/50" />
                  </div>
                  <div class="min-w-0 flex-1">
                    <div class="flex flex-wrap items-center gap-2">
                      <span class="font-mono text-[11px] text-muted-foreground">#{{ item.sequence }}</span>
                      <span class="rounded bg-muted px-1.5 py-0.5 text-[10px]">{{ kindLabel(item.kind) }}</span>
                      <span v-if="item.parentItemId" class="rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-700">
                        修复 {{ item.repairGeneration }}
                      </span>
                    </div>
                    <p class="mt-1 truncate text-sm font-medium">{{ item.title }}</p>
                    <p class="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">{{ item.objective }}</p>
                  </div>
                  <span class="text-[11px] font-medium" :class="itemTone(item)">
                    {{ t(`jobs.itemStates.${item.state}`) }}
                  </span>
                </button>
              </div>
            </section>
          </div>
        </div>

        <aside class="min-h-0 overflow-y-auto bg-muted/20 p-5">
          <div v-if="selectedItem" class="space-y-4">
            <div>
              <div class="flex flex-wrap items-center gap-2">
                <span class="font-mono text-xs text-muted-foreground">#{{ selectedItem.sequence }}</span>
                <span class="rounded bg-muted px-2 py-0.5 text-xs">{{ kindLabel(selectedItem.kind) }}</span>
              </div>
              <h2 class="mt-2 text-lg font-semibold">{{ selectedItem.title }}</h2>
              <p class="mt-2 whitespace-pre-wrap text-sm leading-6 text-muted-foreground">{{ selectedItem.objective }}</p>
            </div>
            <section class="grid grid-cols-2 gap-2 text-xs">
              <div class="rounded-lg border border-border bg-card p-3">
                <p class="text-muted-foreground">Provider</p>
                <p class="mt-1 font-medium">{{ selectedItem.provider }} · 宿主当前模型</p>
              </div>
              <div class="rounded-lg border border-border bg-card p-3">
                <p class="text-muted-foreground">尝试 / 耗时</p>
                <p class="mt-1 font-medium">{{ selectedItem.attempt }} / {{ formatDuration(selectedItem) }}</p>
              </div>
            </section>
            <section v-if="selectedItem.files.length" class="rounded-lg border border-border bg-card p-4">
              <h3 class="flex items-center gap-2 text-sm font-semibold"><Files class="size-4" />文件范围</h3>
              <ul class="mt-2 space-y-1 font-mono text-xs">
                <li v-for="file in selectedItem.files" :key="file" class="break-all">{{ file }}</li>
              </ul>
            </section>
            <section class="rounded-lg border border-border bg-card p-4">
              <h3 class="flex items-center gap-2 text-sm font-semibold"><FileCheck2 class="size-4" />验收标准</h3>
              <ul class="mt-2 list-disc space-y-1.5 pl-5 text-xs leading-5">
                <li v-for="criterion in selectedItem.acceptanceCriteria" :key="criterion">{{ criterion }}</li>
              </ul>
            </section>
            <section v-if="selectedItem.result" class="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-4">
              <h3 class="flex items-center gap-2 text-sm font-semibold text-emerald-700"><ShieldCheck class="size-4" />执行结果</h3>
              <p class="mt-2 whitespace-pre-wrap text-sm">{{ selectedItem.result.summary }}</p>
              <div v-if="selectedItem.result.changedFiles?.length" class="mt-3">
                <p class="text-xs font-medium">变更文件</p>
                <ul class="mt-1 space-y-1 font-mono text-xs">
                  <li v-for="file in selectedItem.result.changedFiles" :key="file">{{ file }}</li>
                </ul>
              </div>
              <div v-if="selectedItem.result.evidence.length" class="mt-3">
                <p class="text-xs font-medium">证据</p>
                <ul class="mt-1 list-disc space-y-1 pl-5 text-xs">
                  <li v-for="evidence in selectedItem.result.evidence" :key="evidence">{{ evidence }}</li>
                </ul>
              </div>
            </section>
            <section v-if="selectedItem.error" class="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-destructive">
              <h3 class="flex items-center gap-2 text-sm font-semibold"><AlertTriangle class="size-4" />失败详情</h3>
              <p class="mt-2 text-xs">{{ selectedItem.error.code }}</p>
              <p class="mt-1 whitespace-pre-wrap text-sm">{{ selectedItem.error.message }}</p>
            </section>
            <section class="rounded-lg border border-border bg-card p-4 text-xs">
              <div class="flex justify-between gap-3"><span class="text-muted-foreground">开始</span><span>{{ formatTime(selectedItem.startedAtMs) }}</span></div>
              <div class="mt-2 flex justify-between gap-3"><span class="text-muted-foreground">结束</span><span>{{ formatTime(selectedItem.finishedAtMs) }}</span></div>
            </section>
          </div>
          <div v-else class="py-16 text-center text-sm text-muted-foreground">选择一个 Work 或校验节点查看详情。</div>
        </aside>
      </div>

      <div v-else class="min-h-0 flex-1 overflow-y-auto p-5">
        <div class="mx-auto max-w-5xl space-y-5">
          <section class="grid gap-4 lg:grid-cols-2">
            <div class="rounded-xl border border-border bg-card p-5">
              <h2 class="text-sm font-semibold">源需求快照</h2>
              <p class="mt-3 text-xs font-medium text-muted-foreground">目标</p>
              <p class="mt-1 whitespace-pre-wrap text-sm leading-6">{{ selected.sourceDraft.objective }}</p>
              <p class="mt-3 text-xs font-medium text-muted-foreground">详细需求</p>
              <p class="mt-1 whitespace-pre-wrap text-sm leading-6">{{ selected.sourceDraft.requirements }}</p>
              <p class="mt-3 text-xs font-medium text-muted-foreground">验收标准</p>
              <p class="mt-1 whitespace-pre-wrap text-sm leading-6">{{ selected.sourceDraft.acceptanceCriteria }}</p>
            </div>
            <div class="rounded-xl border border-border bg-card p-5">
              <h2 class="text-sm font-semibold">运行参数</h2>
              <dl class="mt-3 space-y-3 text-sm">
                <div class="flex justify-between gap-4"><dt class="text-muted-foreground">工作区</dt><dd class="break-all text-right">{{ selected.workspace.rootPath }}</dd></div>
                <div class="flex justify-between gap-4"><dt class="text-muted-foreground">队列位置</dt><dd>{{ selected.queuePosition ?? '已进入执行/历史' }}</dd></div>
                <div class="flex justify-between gap-4"><dt class="text-muted-foreground">开始时间</dt><dd>{{ formatTime(selected.startedAtMs) }}</dd></div>
                <div class="flex justify-between gap-4"><dt class="text-muted-foreground">完成时间</dt><dd>{{ formatTime(selected.finishedAtMs) }}</dd></div>
              </dl>
              <div v-if="selected.attachments.length" class="mt-5 border-t border-border pt-4">
                <h3 class="text-xs font-semibold">Job 自有附件</h3>
                <div v-for="attachment in selected.attachments" :key="attachment.id" class="mt-2 flex items-center justify-between gap-3 rounded-lg bg-muted px-3 py-2 text-xs">
                  <span class="truncate">{{ attachment.displayName }}</span>
                  <span class="shrink-0 text-muted-foreground">{{ formatBytes(attachment.sizeBytes) }}</span>
                </div>
              </div>
            </div>
          </section>

          <section class="space-y-4">
            <article v-for="milestone in selected.executionTree.milestones" :key="milestone.id" class="rounded-xl border border-border bg-card p-5">
              <div class="flex items-start gap-3">
                <span class="rounded bg-primary/10 px-2 py-1 font-mono text-xs text-primary">{{ milestone.id }}</span>
                <div>
                  <h2 class="font-semibold">{{ milestone.title }}</h2>
                  <p class="mt-1 text-sm text-muted-foreground">{{ milestone.objective }}</p>
                  <p class="mt-2 text-xs"><strong>完成标准：</strong>{{ milestone.successCriteria }}</p>
                </div>
              </div>
              <div class="mt-4 space-y-3">
                <div v-for="slice in milestone.slices" :key="slice.id" class="rounded-lg border border-border/80 p-4">
                  <div class="flex items-center gap-2"><span class="font-mono text-xs text-muted-foreground">{{ slice.id }}</span><h3 class="text-sm font-semibold">{{ slice.title }}</h3></div>
                  <p class="mt-1 text-xs text-muted-foreground">{{ slice.objective }}</p>
                  <div class="mt-3 grid gap-2 lg:grid-cols-2">
                    <div v-for="task in slice.tasks" :key="task.id" class="rounded-md bg-muted/60 p-3 text-xs">
                      <div class="flex items-center gap-2"><Wrench class="size-3.5" /><span class="font-medium">{{ task.title }}</span><span class="ml-auto">{{ task.estimatedMinutes }}m</span></div>
                      <p class="mt-1 text-muted-foreground">{{ task.objective }}</p>
                    </div>
                  </div>
                </div>
              </div>
            </article>
          </section>
        </div>
      </div>
    </section>
  </div>
</template>
