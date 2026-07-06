<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { browseFilesystem, fetchBrowseParent } from '@renderer/api/fs'
import type { BrowseEntry } from '@renderer/api/fs'
import type { HomeProject } from '@renderer/composables/useHomeWorkspace'
import FolderBrowsePanel from '@renderer/components/shared/FolderBrowsePanel.vue'
import Button from '@renderer/components/ui/Button.vue'
import Dialog from '@renderer/components/ui/Dialog.vue'
import Input from '@renderer/components/ui/Input.vue'
import { translateApiError } from '@renderer/i18n/translateApiError'
import {
  defaultBrowsePath,
  joinChildPath,
  withTrailingSeparator,
  workspaceRootsMatch
} from '@renderer/lib/workspace'
import { cn } from '@renderer/lib/utils'

const props = defineProps<{
  open: boolean
  projects: HomeProject[]
  loading?: boolean
}>()

const emit = defineEmits<{
  close: []
  selectProject: [projectId: string]
  addProject: [workspaceRoot: string]
}>()

const { t } = useI18n()

type TabId = 'browse' | 'recent'

const activeTab = ref<TabId>('browse')
const query = ref(defaultBrowsePath())
const parentPath = ref('')
const entries = ref<BrowseEntry[]>([])
const newFolderName = ref('')
const browsing = ref(false)
const submitting = ref(false)
const error = ref<string | null>(null)

const tabs = computed(() => [
  { id: 'browse' as const, label: t('workspace.create.tabBrowseDirectory') },
  { id: 'recent' as const, label: t('workspace.create.tabRecentDirectories') }
])

const recentProjects = computed(() => [...props.projects].sort((a, b) => b.updatedAt - a.updatedAt))

function resetBrowse(): void {
  query.value = defaultBrowsePath()
  parentPath.value = ''
  entries.value = []
  newFolderName.value = ''
  browsing.value = false
  submitting.value = false
  error.value = null
}

function reset(): void {
  activeTab.value = 'browse'
  resetBrowse()
}

async function loadBrowse(partialPath: string): Promise<void> {
  browsing.value = true
  error.value = null
  try {
    const res = await browseFilesystem(partialPath)
    parentPath.value = res.data.parentPath
    entries.value = res.data.entries
    if (!partialPath.trim()) {
      query.value = res.data.parentPath
    }
  } catch (err) {
    parentPath.value = ''
    entries.value = []
    const message = err instanceof Error ? err.message : t('folderPicker.browseFailed')
    error.value = translateApiError(message, t)
  } finally {
    browsing.value = false
  }
}

function currentDirectoryPath(): string {
  return parentPath.value || query.value.trim()
}

function openEntry(entry: BrowseEntry): void {
  query.value = withTrailingSeparator(entry.path)
  newFolderName.value = ''
}

async function goParent(): Promise<void> {
  const target = currentDirectoryPath()
  if (!target) return
  browsing.value = true
  error.value = null
  try {
    const res = await fetchBrowseParent(target)
    query.value = withTrailingSeparator(res.data.parentPath)
    newFolderName.value = ''
    await loadBrowse(query.value)
  } catch (err) {
    const message = err instanceof Error ? err.message : t('folderPicker.parentFailed')
    error.value = translateApiError(message, t)
  } finally {
    browsing.value = false
  }
}

async function submitFolder(targetPath?: string): Promise<void> {
  const target = targetPath?.trim() || query.value.trim() || parentPath.value
  if (!target) {
    error.value = t('folderPicker.selectRequired')
    return
  }
  submitting.value = true
  error.value = null
  try {
    const existing = props.projects.find((project) =>
      workspaceRootsMatch(project.workspaceRoot, target)
    )
    if (existing) {
      emit('selectProject', existing.id)
    } else {
      emit('addProject', target)
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : t('folderPicker.addFailed')
    error.value = translateApiError(message, t)
  } finally {
    submitting.value = false
  }
}

function createAndSubmitFolder(): void {
  const base = currentDirectoryPath()
  const target = joinChildPath(base, newFolderName.value)
  if (!target) {
    error.value = t('folderPicker.folderNameRequired')
    return
  }
  void submitFolder(target)
}

function selectRecentProject(projectId: string): void {
  if (props.loading) return
  emit('selectProject', projectId)
}

watch(
  () => props.open,
  (isOpen) => {
    if (!isOpen) {
      reset()
      return
    }
    resetBrowse()
    void loadBrowse(query.value)
  }
)

let browseTimer: number | undefined
watch(query, (value) => {
  if (!props.open || activeTab.value !== 'browse') return
  if (browseTimer !== undefined) {
    window.clearTimeout(browseTimer)
  }
  browseTimer = window.setTimeout(() => {
    void loadBrowse(value)
  }, 200)
})
</script>

<template>
  <Dialog
    :open="open"
    class="flex h-[min(85vh,720px)] min-h-0 max-h-[min(85vh,720px)] max-w-2xl flex-col"
    @close="emit('close')"
  >
    <div class="shrink-0 border-b border-border px-4 py-4">
      <h2 class="text-base font-semibold">{{ t('workspace.create.projectDialogTitle') }}</h2>
      <p class="mt-1 text-sm text-muted-foreground">
        {{ t('workspace.create.projectDialogHint') }}
      </p>
      <div class="mt-4 flex gap-1 rounded-lg bg-muted/60 p-1">
        <button
          v-for="tab in tabs"
          :key="tab.id"
          type="button"
          :class="
            cn(
              'flex-1 rounded-md px-3 py-2 text-sm transition-colors',
              activeTab === tab.id
                ? 'bg-background font-medium text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            )
          "
          @click="activeTab = tab.id"
        >
          {{ tab.label }}
        </button>
      </div>
    </div>

    <div class="flex min-h-0 flex-1 flex-col overflow-hidden">
      <FolderBrowsePanel
        v-if="activeTab === 'browse'"
        fill-height
        hide-footer
        v-model:query="query"
        v-model:new-folder-name="newFolderName"
        :parent-path="parentPath"
        :current-path="currentDirectoryPath()"
        :entries="entries"
        :loading="browsing"
        :submitting="submitting || loading"
        :error="error"
        @go-parent="goParent"
        @open-entry="openEntry"
        @select="submitFolder"
      />

      <div v-else class="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <p
          v-if="recentProjects.length === 0"
          class="rounded-md border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground"
        >
          {{ t('workspace.create.recentDirectoriesEmpty') }}
        </p>
        <ul v-else class="space-y-2">
          <li v-for="project in recentProjects" :key="project.id">
            <button
              type="button"
              class="flex w-full items-center gap-3 rounded-lg border border-border bg-card px-3 py-2.5 text-left text-sm shadow-sm transition-colors hover:bg-muted disabled:opacity-50"
              :disabled="loading"
              @click="selectRecentProject(project.id)"
            >
              <span class="text-muted-foreground" aria-hidden>📁</span>
              <span class="min-w-0 flex-1">
                <span class="block truncate font-medium">{{ project.title }}</span>
                <span class="mt-0.5 block truncate text-xs text-muted-foreground">
                  {{ project.workspaceRoot }}
                </span>
              </span>
            </button>
          </li>
        </ul>
      </div>
    </div>

    <div v-if="activeTab === 'browse'" class="shrink-0 space-y-3 border-t border-border px-4 py-3">
      <div class="flex items-center gap-2">
        <Input
          v-model="newFolderName"
          class="min-w-0 flex-1"
          :placeholder="t('folderPicker.newFolderPlaceholder')"
          @keydown.enter.prevent="createAndSubmitFolder()"
        />
        <Button
          type="button"
          variant="outline"
          class="shrink-0 whitespace-nowrap"
          :disabled="submitting || loading || !newFolderName.trim()"
          @click="createAndSubmitFolder"
        >
          {{ t('folderPicker.createAndAdd') }}
        </Button>
      </div>
      <div class="flex items-center justify-between gap-3">
        <span class="truncate text-xs text-muted-foreground">
          {{ t('folderPicker.currentDirectory', { path: currentDirectoryPath() || '—' }) }}
        </span>
        <Button
          type="button"
          :disabled="submitting || loading || !currentDirectoryPath()"
          @click="submitFolder(currentDirectoryPath())"
        >
          {{ submitting || loading ? t('folderPicker.adding') : t('folderPicker.selectCurrent') }}
        </Button>
      </div>
    </div>

    <div class="shrink-0 flex justify-end border-t border-border px-4 py-3">
      <Button type="button" variant="outline" @click="emit('close')">
        {{ t('common.cancel') }}
      </Button>
    </div>
  </Dialog>
</template>
