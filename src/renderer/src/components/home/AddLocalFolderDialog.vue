<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useHomeWorkspace } from '@renderer/composables/useHomeWorkspace'
import { useFolderBrowse } from '@renderer/composables/useFolderBrowse'
import FolderBrowseDialog from '@renderer/components/shared/FolderBrowseDialog.vue'
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
  <FolderBrowseDialog
    v-model:query="query"
    v-model:new-folder-name="newFolderName"
    :open="open"
    :parent-path="parentPath"
    :current-path="currentDirectoryPath()"
    :entries="entries"
    :loading="loading"
    :submitting="submitting"
    :error="error"
    @close="open = false"
    @go-parent="goParent"
    @open-entry="openEntry"
    @select="submit"
    @create-folder="createAndSubmitFolder"
  />
</template>
