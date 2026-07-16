<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useDebounceFn } from '@vueuse/core'
import { Trash2 } from 'lucide-vue-next'
import { deleteUserDraft, fetchUserDrafts, type UserDraftListItem } from '@renderer/api/jobs'
import Button from '@renderer/components/ui/Button.vue'
import ConfirmDialog from '@renderer/components/ui/ConfirmDialog.vue'
import ErrorAlert from '@renderer/components/ui/ErrorAlert.vue'
import Input from '@renderer/components/ui/Input.vue'
import { DRAFT_WIZARD_STEP_COUNT } from '@renderer/lib/draftForm'
import { toastError } from '@renderer/lib/toast'

export type DraftListEntry = UserDraftListItem

const emit = defineEmits<{
  continueDraft: [entry: DraftListEntry]
  createNew: []
}>()

const { t } = useI18n()

const loading = ref(false)
let loadToken = 0
const error = ref<string | null>(null)
const entries = ref<DraftListEntry[]>([])
const searchQuery = ref('')
const completionFilter = ref<'all' | 'incomplete' | 'complete'>('all')
const pendingDelete = ref<DraftListEntry | null>(null)
const deleting = ref(false)

const completionFilters = computed(() => [
  { value: 'all' as const, label: t('workspace.create.draftFilterAll') },
  { value: 'incomplete' as const, label: t('workspace.create.draftFilterIncomplete') },
  { value: 'complete' as const, label: t('workspace.create.draftFilterComplete') }
])

const emptyMessage = computed(() => {
  if (searchQuery.value.trim()) return t('workspace.create.draftSearchEmpty')
  if (completionFilter.value === 'incomplete') return t('workspace.create.draftIncompleteEmpty')
  return t('workspace.create.draftListEmpty')
})

const confirmDeleteTitle = computed(() => t('workspace.create.confirmDeleteDraftTitle'))

const confirmDeleteMessage = computed(() => {
  const entry = pendingDelete.value
  if (!entry) return ''
  if (entry.launched) {
    return t('workspace.create.confirmDeleteDraftLaunchedMessage', { name: entry.title })
  }
  return t('workspace.create.confirmDeleteDraftMessage', { name: entry.title })
})

function isStillCollecting(draft: DraftListEntry): boolean {
  return Boolean(draft.collecting) && !draft.summary?.trim()
}

function approximateStep(draft: DraftListEntry): number {
  if (isStillCollecting(draft)) return 0
  const planStatus = draft.plan?.status
  if (
    planStatus === 'plan_editing' ||
    planStatus === 'planning' ||
    planStatus === 'failed' ||
    planStatus === 'cancelled' ||
    draft.linkedPlanId
  ) {
    return 2
  }
  return 1
}

function stepLabel(draft: DraftListEntry): string {
  const step = approximateStep(draft)
  return t('workspace.create.stepProgress', {
    current: step + 1,
    total: DRAFT_WIZARD_STEP_COUNT
  })
}

function draftStatusLabel(entry: DraftListEntry): string {
  if (isStillCollecting(entry)) return t('workspace.create.draftStatusCollecting')
  if (entry.launched) return t('workspace.create.draftStatusLaunched')
  if (entry.plan?.status === 'failed' || entry.plan?.status === 'cancelled') {
    return t('workspace.create.draftStatusPlanningFailed')
  }
  if (entry.status === 'confirmed') return t('workspace.draftPanel.statusConfirmed')
  if (entry.status === 'archived') return t('workspace.draftPanel.statusArchived')
  return t('workspace.create.draftStatusInProgress')
}

function draftStatusBadgeClass(entry: DraftListEntry): string {
  if (isStillCollecting(entry)) return 'bg-sky-50 text-sky-700'
  if (entry.launched) return 'bg-emerald-50 text-emerald-700'
  if (entry.plan?.status === 'failed' || entry.plan?.status === 'cancelled') {
    return 'bg-red-50 text-red-700'
  }
  return 'bg-amber-50 text-amber-700'
}

async function loadAllDrafts(): Promise<void> {
  const token = ++loadToken
  loading.value = true
  error.value = null
  try {
    const res = await fetchUserDrafts({
      q: searchQuery.value,
      completion: completionFilter.value
    })
    if (token !== loadToken) return
    entries.value = res.data.drafts
  } catch (err) {
    if (token !== loadToken) return
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    if (token === loadToken) {
      loading.value = false
    }
  }
}

const debouncedLoad = useDebounceFn(() => {
  void loadAllDrafts()
}, 300)

watch([searchQuery, completionFilter], () => {
  void debouncedLoad()
})

onMounted(() => {
  void loadAllDrafts()
})

function requestDelete(entry: DraftListEntry, event: Event): void {
  event.preventDefault()
  event.stopPropagation()
  pendingDelete.value = entry
}

async function handleConfirmDelete(): Promise<void> {
  const entry = pendingDelete.value
  if (!entry || deleting.value) return
  deleting.value = true
  try {
    await deleteUserDraft(entry.threadId, entry.messageId)
    pendingDelete.value = null
    await loadAllDrafts()
  } catch (err) {
    toastError(err, t('workspace.create.deleteDraftFailed'))
  } finally {
    deleting.value = false
  }
}

defineExpose({ reload: loadAllDrafts })
</script>

<template>
  <div class="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-8">
    <div class="flex items-start justify-between gap-4">
      <div>
        <h1 class="text-lg font-semibold">{{ t('workspace.create.draftListTitle') }}</h1>
        <p class="mt-1 text-sm text-muted-foreground">{{ t('workspace.create.draftListHint') }}</p>
      </div>
      <Button type="button" class="shrink-0" @click="emit('createNew')">
        {{ t('workspace.create.startNew') }}
      </Button>
    </div>

    <div class="space-y-3">
      <Input
        v-model="searchQuery"
        type="search"
        :placeholder="t('workspace.create.draftSearchPlaceholder')"
      />
      <div class="flex flex-wrap gap-2">
        <button
          v-for="filter in completionFilters"
          :key="filter.value"
          type="button"
          class="rounded-md px-2.5 py-1 text-xs transition-colors"
          :class="
            completionFilter === filter.value
              ? 'bg-primary text-primary-foreground'
              : 'bg-muted text-muted-foreground hover:bg-muted/80'
          "
          @click="completionFilter = filter.value"
        >
          {{ filter.label }}
        </button>
      </div>
    </div>

    <ErrorAlert v-if="error" :message="error" />

    <div v-if="loading" class="py-12 text-center text-sm text-muted-foreground">
      {{ t('workspace.loading') }}
    </div>

    <ul v-else-if="entries.length > 0" class="space-y-2">
      <li v-for="entry in entries" :key="`${entry.threadId}:${entry.messageId}`">
        <div
          class="flex w-full items-stretch gap-1 rounded-xl border border-border bg-card shadow-sm transition-colors hover:bg-muted"
        >
          <button
            type="button"
            class="flex min-w-0 flex-1 flex-col gap-1 px-4 py-3 text-left"
            @click="emit('continueDraft', entry)"
          >
            <div class="flex items-center justify-between gap-2">
              <span class="truncate font-medium">{{ entry.title }}</span>
              <div class="flex shrink-0 items-center gap-2">
                <span
                  class="rounded px-1.5 py-0.5 text-[10px] font-medium"
                  :class="draftStatusBadgeClass(entry)"
                >
                  {{ draftStatusLabel(entry) }}
                </span>
                <span class="text-xs text-muted-foreground">{{ stepLabel(entry) }}</span>
              </div>
            </div>
            <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <span>{{ entry.projectTitle }}</span>
              <span>·</span>
              <span>{{ entry.threadTitle }}</span>
              <span>·</span>
              <span>{{ draftStatusLabel(entry) }}</span>
            </div>
            <p v-if="entry.summary" class="line-clamp-2 text-xs text-muted-foreground/80">
              {{ entry.summary }}
            </p>
          </button>
          <div class="flex items-center pr-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              class="h-8 w-8 shrink-0 p-0 text-muted-foreground hover:text-destructive"
              :aria-label="t('common.delete')"
              @click="requestDelete(entry, $event)"
            >
              <Trash2 class="h-4 w-4" />
            </Button>
          </div>
        </div>
      </li>
    </ul>

    <div v-else class="rounded-xl border border-dashed border-border py-16 text-center">
      <p class="text-sm text-muted-foreground">{{ emptyMessage }}</p>
    </div>

    <ConfirmDialog
      :open="Boolean(pendingDelete)"
      :title="confirmDeleteTitle"
      :message="confirmDeleteMessage"
      :loading="deleting"
      @close="pendingDelete = null"
      @confirm="handleConfirmDelete"
    />
  </div>
</template>
