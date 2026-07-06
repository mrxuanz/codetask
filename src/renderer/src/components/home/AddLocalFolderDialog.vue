<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { browseFilesystem, fetchBrowseParent } from '@renderer/api/fs'
import type { BrowseEntry } from '@renderer/api/fs'
import { useHomeWorkspace } from '@renderer/composables/useHomeWorkspace'
import Button from '@renderer/components/ui/Button.vue'
import Dialog from '@renderer/components/ui/Dialog.vue'
import ErrorAlert from '@renderer/components/ui/ErrorAlert.vue'
import Input from '@renderer/components/ui/Input.vue'
import Spinner from '@renderer/components/ui/Spinner.vue'
import { translateApiError } from '@renderer/i18n/translateApiError'
import { defaultBrowsePath, joinChildPath, withTrailingSeparator } from '@renderer/lib/workspace'

const { t } = useI18n()
const workspace = useHomeWorkspace()

const open = computed({
  get: () => workspace.addProjectOpen.value,
  set: (value: boolean) => workspace.setAddProjectOpen(value)
})

const query = ref(defaultBrowsePath())
const parentPath = ref('')
const entries = ref<BrowseEntry[]>([])
const newFolderName = ref('')
const loading = ref(false)
const submitting = ref(false)
const error = ref<string | null>(null)

function reset(): void {
  query.value = defaultBrowsePath()
  parentPath.value = ''
  entries.value = []
  newFolderName.value = ''
  error.value = null
  loading.value = false
  submitting.value = false
}

async function loadBrowse(partialPath: string): Promise<void> {
  loading.value = true
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
    loading.value = false
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
  loading.value = true
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
    loading.value = false
  }
}

async function submit(targetPath?: string): Promise<void> {
  const target = targetPath?.trim() || query.value.trim() || parentPath.value
  if (!target) {
    error.value = t('folderPicker.selectRequired')
    return
  }
  submitting.value = true
  error.value = null
  try {
    await workspace.addLocalProject(target)
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
  void submit(target)
}

watch(open, (isOpen) => {
  if (!isOpen) {
    reset()
    return
  }
  query.value = defaultBrowsePath()
  void loadBrowse(query.value)
})

let browseTimer: number | undefined
watch(query, (value) => {
  if (!open.value) return
  if (browseTimer !== undefined) {
    window.clearTimeout(browseTimer)
  }
  browseTimer = window.setTimeout(() => {
    void loadBrowse(value)
  }, 200)
})
</script>

<template>
  <Dialog :open="open" @close="open = false">
    <div class="space-y-0">
      <div class="space-y-2 border-b border-border px-4 py-3">
        <div class="flex items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            :disabled="loading || !currentDirectoryPath()"
            :aria-label="t('folderPicker.goParent')"
            @click="goParent"
          >
            ←
          </Button>
          <Input
            v-model="query"
            :placeholder="t('folderPicker.pathPlaceholder')"
            class="border-0 px-0 shadow-none focus-visible:ring-0"
            @keydown.enter.prevent="submit()"
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
            :disabled="loading || !currentDirectoryPath()"
            @click="goParent"
          >
            ..
          </Button>
          <Spinner v-if="loading" />
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
                :disabled="submitting"
                @click="submit(entry.path)"
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
            :disabled="submitting || !newFolderName.trim()"
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
            :disabled="submitting || !currentDirectoryPath()"
            @click="submit(currentDirectoryPath())"
          >
            {{ submitting ? t('folderPicker.adding') : t('folderPicker.selectCurrent') }}
          </Button>
        </div>
      </div>
    </div>
  </Dialog>
</template>
