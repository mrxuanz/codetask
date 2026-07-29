<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useHomeWorkspace } from '@renderer/composables/useHomeWorkspace'
import { useFolderBrowse } from '@renderer/composables/useFolderBrowse'
import Button from '@renderer/components/ui/Button.vue'
import Dialog from '@renderer/components/ui/Dialog.vue'
import ErrorAlert from '@renderer/components/ui/ErrorAlert.vue'
import Input from '@renderer/components/ui/Input.vue'
import Spinner from '@renderer/components/ui/Spinner.vue'
import { translateApiError } from '@renderer/i18n/translateApiError'

const { t } = useI18n()
const workspace = useHomeWorkspace()

const open = computed({
  get: () => workspace.addProjectOpen.value,
  set: (value: boolean) => workspace.setAddProjectOpen(value)
})

const submitting = ref(false)
const {
  query,
  parentPath,
  entries,
  newFolderName,
  loading,
  error,
  reset: resetBrowse,
  currentDirectoryPath,
  openEntry,
  goParent,
  selectFolder,
  createFolder,
  start
} = useFolderBrowse({ active: open })

function reset(): void {
  resetBrowse()
  submitting.value = false
}

async function submit(targetPath?: string): Promise<void> {
  submitting.value = true
  error.value = null
  try {
    const path = await selectFolder(targetPath)
    if (!path) return
    await workspace.addLocalProject(path)
  } catch (err) {
    const message = err instanceof Error ? err.message : t('folderPicker.addFailed')
    error.value = translateApiError(message, t)
  } finally {
    submitting.value = false
  }
}

async function createAndSubmitFolder(): Promise<void> {
  submitting.value = true
  error.value = null
  try {
    const path = await createFolder()
    if (!path) return
    await workspace.addLocalProject(path)
  } catch (err) {
    const message = err instanceof Error ? err.message : t('folderPicker.addFailed')
    error.value = translateApiError(message, t)
  } finally {
    submitting.value = false
  }
}

watch(open, (isOpen) => {
  if (!isOpen) {
    reset()
    return
  }
  start()
})
</script>

<template>
  <Dialog :open="open" @close="open = false">
    <div class="space-y-0">
      <div class="space-y-2 border-b border-border px-3 py-3 sm:px-4">
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

      <div class="max-h-72 space-y-2 overflow-y-auto px-3 py-3 sm:px-4">
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

      <div class="space-y-3 border-t border-border px-3 py-3 sm:px-4">
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
        <div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
          <span class="truncate text-xs text-muted-foreground">
            {{ t('folderPicker.currentDirectory', { path: currentDirectoryPath() || '—' }) }}
          </span>
          <Button
            type="button"
            class="w-full sm:w-auto"
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
