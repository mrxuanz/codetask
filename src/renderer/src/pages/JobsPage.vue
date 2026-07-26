<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import AppHeader from '@renderer/components/AppHeader.vue'
import Button from '@renderer/components/ui/Button.vue'
import ErrorAlert from '@renderer/components/ui/ErrorAlert.vue'
import Spinner from '@renderer/components/ui/Spinner.vue'
import {
  continueJob,
  deleteJob,
  fetchJobs,
  pauseJob,
  subscribeJobEvents,
  type JobItemKind,
  type JobSnapshot,
  type JobState
} from '@renderer/api/jobs'
import { useBootstrap } from '@renderer/composables/useBootstrap'
import { translateApiError } from '@renderer/i18n/translateApiError'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const { data } = useBootstrap()
const jobs = ref<JobSnapshot[]>([])
const selectedId = ref<string | null>(null)
const loading = ref(true)
const acting = ref(false)
const error = ref<string | null>(null)
let unsubscribe: (() => void) | null = null
let refreshTimer: number | null = null

const selected = computed(() => jobs.value.find((job) => job.id === selectedId.value) ?? null)
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

function stateLabel(state: JobState): string {
  return t(`jobs.states.${state}`)
}

function kindLabel(kind: JobItemKind): string {
  return t(`jobs.kinds.${kind}`)
}

function progress(job: JobSnapshot): number {
  return job.totalItems === 0 ? 0 : Math.round((job.completedItems / job.totalItems) * 100)
}

function reportError(cause: unknown): void {
  error.value = translateApiError(cause instanceof Error ? cause.message : String(cause), t)
}

async function selectJob(id: string): Promise<void> {
  selectedId.value = id
  await router.replace({ path: '/jobs', query: { selected: id } })
}

async function load(preferredId?: string): Promise<void> {
  error.value = null
  try {
    jobs.value = (await fetchJobs()).data
    const target =
      jobs.value.find((job) => job.id === preferredId) ??
      jobs.value.find((job) => job.id === selectedId.value) ??
      jobs.value[0]
    selectedId.value = target?.id ?? null
  } catch (cause) {
    reportError(cause)
  } finally {
    loading.value = false
  }
}

function scheduleRefresh(): void {
  if (refreshTimer !== null) return
  refreshTimer = window.setTimeout(() => {
    refreshTimer = null
    void load()
  }, 100)
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

onMounted(async () => {
  const preferred = typeof route.query.selected === 'string' ? route.query.selected : undefined
  await load(preferred)
  unsubscribe = subscribeJobEvents(() => scheduleRefresh())
})

onUnmounted(() => {
  unsubscribe?.()
  if (refreshTimer !== null) window.clearTimeout(refreshTimer)
})
</script>

<template>
  <main class="flex h-full min-h-0 flex-col bg-background">
    <AppHeader :username="data?.username" />
    <div class="flex min-h-0 flex-1">
      <aside class="flex w-80 shrink-0 flex-col border-r border-border bg-card">
        <div class="border-b border-border p-4">
          <h1 class="font-semibold">{{ t('jobs.title') }}</h1>
          <p class="mt-1 text-xs text-muted-foreground">{{ t('jobs.description') }}</p>
        </div>
        <div class="min-h-0 flex-1 space-y-5 overflow-y-auto p-3">
          <div v-if="loading" class="flex justify-center p-8"><Spinner /></div>
          <template v-else>
            <section>
              <h2 class="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {{ t('jobs.executionPool') }} · {{ executionPool.length }}/2
              </h2>
              <p
                v-if="executionPool.length === 0"
                class="rounded border border-dashed p-3 text-xs text-muted-foreground"
              >
                {{ t('jobs.poolEmpty') }}
              </p>
              <button
                v-for="job in executionPool"
                :key="job.id"
                type="button"
                class="mb-2 w-full rounded-lg border p-3 text-left"
                :class="selectedId === job.id ? 'border-primary bg-muted' : 'border-border'"
                @click="selectJob(job.id)"
              >
                <span class="block truncate text-sm font-medium">{{ job.title }}</span>
                <span class="mt-1 block text-xs text-muted-foreground">
                  {{ stateLabel(job.state) }} · {{ job.completedItems }}/{{ job.totalItems }}
                </span>
              </button>
            </section>

            <section>
              <h2 class="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {{ t('jobs.waitingQueue') }} · {{ waitingQueue.length }}
              </h2>
              <p
                v-if="waitingQueue.length === 0"
                class="rounded border border-dashed p-3 text-xs text-muted-foreground"
              >
                {{ t('jobs.queueEmpty') }}
              </p>
              <button
                v-for="job in waitingQueue"
                :key="job.id"
                type="button"
                class="mb-2 w-full rounded-lg border p-3 text-left"
                :class="selectedId === job.id ? 'border-primary bg-muted' : 'border-border'"
                @click="selectJob(job.id)"
              >
                <span class="block truncate text-sm font-medium">
                  #{{ job.queuePosition }} {{ job.title }}
                </span>
                <span class="mt-1 block text-xs text-muted-foreground">
                  {{ job.completedItems }}/{{ job.totalItems }}
                </span>
              </button>
            </section>

            <section>
              <h2 class="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {{ t('jobs.retained') }}
              </h2>
              <button
                v-for="job in retained"
                :key="job.id"
                type="button"
                class="mb-2 w-full rounded-lg border p-3 text-left"
                :class="selectedId === job.id ? 'border-primary bg-muted' : 'border-border'"
                @click="selectJob(job.id)"
              >
                <span class="block truncate text-sm font-medium">{{ job.title }}</span>
                <span class="mt-1 block text-xs text-muted-foreground">
                  {{ stateLabel(job.state) }} · {{ job.completedItems }}/{{ job.totalItems }}
                </span>
              </button>
            </section>
          </template>
        </div>
      </aside>

      <section class="min-h-0 min-w-0 flex-1 overflow-y-auto">
        <div class="mx-auto w-full max-w-5xl space-y-5 p-4 sm:p-6">
          <ErrorAlert v-if="error" :message="error" />
          <div
            v-if="!loading && !selected"
            class="rounded-xl border border-dashed p-12 text-center"
          >
            <h2 class="font-semibold">{{ t('jobs.emptyTitle') }}</h2>
            <p class="mt-2 text-sm text-muted-foreground">{{ t('jobs.emptyDescription') }}</p>
            <RouterLink to="/drafts" class="mt-4 inline-block text-sm text-primary underline">
              {{ t('jobs.goDrafts') }}
            </RouterLink>
          </div>

          <template v-else-if="selected">
            <header class="rounded-xl border border-border bg-card p-5">
              <div class="flex flex-wrap items-start justify-between gap-4">
                <div class="min-w-0">
                  <div class="flex flex-wrap items-center gap-2">
                    <h1 class="text-xl font-semibold">{{ selected.title }}</h1>
                    <span class="rounded-full bg-muted px-2.5 py-1 text-xs font-medium">
                      {{ stateLabel(selected.state) }}
                    </span>
                  </div>
                  <p class="mt-2 text-sm text-muted-foreground">{{ selected.summary }}</p>
                  <p v-if="selected.queuePosition" class="mt-2 text-xs text-muted-foreground">
                    {{ t('jobs.queuePosition', { position: selected.queuePosition }) }}
                  </p>
                </div>
                <div class="flex flex-wrap gap-2">
                  <Button
                    v-if="selected.state === 'queued' || selected.state === 'running'"
                    variant="outline"
                    :disabled="acting"
                    @click="act('pause')"
                  >
                    {{ t('jobs.pause') }}
                  </Button>
                  <Button
                    v-if="['pause_requested', 'paused', 'failed'].includes(selected.state)"
                    :disabled="acting"
                    @click="act('continue')"
                  >
                    {{
                      selected.state === 'pause_requested'
                        ? t('jobs.cancelPause')
                        : t('jobs.continue')
                    }}
                  </Button>
                  <Button variant="outline" :disabled="acting" @click="act('delete')">
                    {{ t('common.delete') }}
                  </Button>
                </div>
              </div>
              <div class="mt-5 h-2 overflow-hidden rounded-full bg-muted">
                <div
                  class="h-full bg-primary transition-all"
                  :style="{ width: `${progress(selected)}%` }"
                />
              </div>
              <p class="mt-2 text-xs text-muted-foreground">
                {{
                  t('jobs.progress', {
                    completed: selected.completedItems,
                    total: selected.totalItems
                  })
                }}
              </p>
              <p
                v-if="selected.lastError"
                class="mt-3 rounded-md bg-destructive/10 p-3 text-sm text-destructive"
              >
                {{ selected.lastError.code }} · {{ selected.lastError.message }}
              </p>
            </header>

            <section class="rounded-xl border border-border bg-card p-5">
              <div class="mb-4">
                <h2 class="font-semibold">{{ t('jobs.timeline') }}</h2>
                <p class="mt-1 text-xs text-muted-foreground">{{ t('jobs.timelineHint') }}</p>
              </div>
              <ol class="space-y-3">
                <li
                  v-for="item in selected.items"
                  :key="item.id"
                  class="rounded-lg border p-4"
                  :class="
                    item.id === selected.activeItemId
                      ? 'border-primary bg-primary/5'
                      : 'border-border'
                  "
                >
                  <div class="flex flex-wrap items-start justify-between gap-3">
                    <div class="min-w-0">
                      <div class="flex flex-wrap items-center gap-2">
                        <span class="text-xs font-mono text-muted-foreground"
                          >#{{ item.sequence }}</span
                        >
                        <span class="rounded bg-muted px-2 py-0.5 text-xs">{{
                          kindLabel(item.kind)
                        }}</span>
                        <span
                          v-if="item.parentItemId"
                          class="rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-900"
                        >
                          {{ t('jobs.repair') }} {{ item.repairGeneration }}
                        </span>
                        <span class="text-xs font-medium">{{
                          t(`jobs.itemStates.${item.state}`)
                        }}</span>
                      </div>
                      <h3 class="mt-2 font-medium">{{ item.title }}</h3>
                      <p class="mt-1 text-sm text-muted-foreground">{{ item.objective }}</p>
                    </div>
                    <div class="text-right text-xs text-muted-foreground">
                      <div>
                        {{ item.provider }}<span v-if="item.model"> · {{ item.model }}</span>
                      </div>
                      <div>{{ t('jobs.attempt', { count: item.attempt }) }}</div>
                    </div>
                  </div>
                  <p v-if="item.result" class="mt-3 rounded bg-muted p-3 text-xs">
                    {{ item.result.summary }}
                  </p>
                  <p
                    v-if="item.error"
                    class="mt-3 rounded bg-destructive/10 p-3 text-xs text-destructive"
                  >
                    {{ item.error.code }} · {{ item.error.message }}
                  </p>
                </li>
              </ol>
            </section>
          </template>
        </div>
      </section>
    </div>
  </main>
</template>
