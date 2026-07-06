<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { browseFilesystem, fetchBrowseParent } from '@renderer/api/fs'
import type { BrowseEntry } from '@renderer/api/fs'
import type { HomeProject } from '@renderer/composables/useHomeWorkspace'
import Button from '@renderer/components/ui/Button.vue'
import ErrorAlert from '@renderer/components/ui/ErrorAlert.vue'
import Input from '@renderer/components/ui/Input.vue'
import Spinner from '@renderer/components/ui/Spinner.vue'
import { translateApiError } from '@renderer/i18n/translateApiError'
import {
  defaultBrowsePath,
  joinChildPath,
  withTrailingSeparator,
  workspaceRootsMatch
} from '@renderer/lib/workspace'

const props = defineProps<{
  projects: HomeProject[]
  loading?: boolean
}>()

const emit = defineEmits<{
  selectProject: [projectId: string]
  addProject: [workspaceRoot: string]
}>()

const { t } = useI18n()

const query = ref(defaultBrowsePath())
const parentPath = ref('')
const entries = ref<BrowseEntry[]>([])
const newFolderName = ref('')
const browsing = ref(false)
const submitting = ref(false)
const error = ref<string | null>(null)

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

onMounted(() => {
  query.value = defaultBrowsePath()
  void loadBrowse(query.value)
})

let browseTimer: number | undefined
watch(query, (value) => {
  if (browseTimer !== undefined) {
    window.clearTimeout(browseTimer)
  }
  browseTimer = window.setTimeout(() => {
    void loadBrowse(value)
  }, 200)
})
</script>

<template>
  <div class="mx-auto flex w-full max-w-2xl flex-col gap-6 px-4 py-8">
    <div>
      <h1 class="text-lg font-semibold">{{ t('workspace.create.selectProjectTitle') }}</h1>
      <p class="mt-1 text-sm text-muted-foreground">
        {{ t('workspace.create.selectProjectHint') }}
      </p>
    </div>

    <div class="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
      <div class="space-y-2 border-b border-border px-4 py-3">
        <div class="flex items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            :disabled="browsing || !currentDirectoryPath()"
            :aria-label="t('folderPicker.goParent')"
            @click="goParent"
          >
            ←
          </Button>
          <Input
            v-model="query"
            :placeholder="t('folderPicker.pathPlaceholder')"
            class="border-0 px-0 shadow-none focus-visible:ring-0"
            @keydown.enter.prevent="submitFolder()"
          />
        </div>
        <p v-if="parentPath" class="truncate text-xs text-muted-foreground">{{ parentPath }}</p>
      </div>

      <div class="max-h-72 space-y-2 overflow-y-auto px-4 py-3">
        <ErrorAlert v-if="error" :message="error" />
        <div class="flex items-center justify-between">
          <Button
            type="button"
            variant="outline"
            size="sm"
            :disabled="browsing || !currentDirectoryPath()"
            @click="goParent"
          >
            ..
          </Button>
          <Spinner v-if="browsing" />
        </div>
        <ul class="space-y-0.5">
          <li v-for="entry in entries" :key="entry.path">
            <div class="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted">
              <button
                type="button"
                class="flex min-w-0 flex-1 items-center gap-2 text-left"
                @click="openEntry(entry)"
              >
                <span class="text-muted-foreground" aria-hidden>📁</span>
                <span class="truncate">{{ entry.name }}</span>
              </button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                class="h-7 px-2 text-xs"
                :disabled="submitting || loading"
                @click="submitFolder(entry.path)"
              >
                {{ t('folderPicker.select') }}
              </Button>
            </div>
          </li>
        </ul>
      </div>

      <div class="space-y-3 border-t border-border px-4 py-3">
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
            {{ submitting ? t('folderPicker.adding') : t('folderPicker.selectCurrent') }}
          </Button>
        </div>
      </div>
    </div>

    <div v-if="projects.length > 0" class="space-y-2">
      <h2 class="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {{ t('workspace.create.existingProjects') }}
      </h2>
      <ul class="space-y-1">
        <li v-for="project in projects" :key="project.id">
          <button
            type="button"
            class="flex w-full items-center gap-3 rounded-lg border border-border bg-card px-3 py-2.5 text-left text-sm shadow-sm transition-colors hover:bg-muted"
            :disabled="loading"
            @click="emit('selectProject', project.id)"
          >
            <span class="text-muted-foreground" aria-hidden>📁</span>
            <span class="min-w-0 flex-1 truncate font-medium">{{ project.title }}</span>
            <span class="hidden max-w-[40%] truncate text-xs text-muted-foreground sm:inline">
              {{ project.workspaceRoot }}
            </span>
          </button>
        </li>
      </ul>
    </div>
  </div>
</template>
