<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import FolderBrowsePanel from '@renderer/components/shared/FolderBrowsePanel.vue'
import Button from '@renderer/components/ui/Button.vue'
import Dialog from '@renderer/components/ui/Dialog.vue'
import ErrorAlert from '@renderer/components/ui/ErrorAlert.vue'
import { createFilesystemFolder } from '@renderer/api/fs'
import { useFolderBrowse } from '@renderer/composables/useFolderBrowse'
import { useHomeWorkspace } from '@renderer/composables/useHomeWorkspace'
import { translateApiError } from '@renderer/i18n/translateApiError'

const { t } = useI18n()
const workspace = useHomeWorkspace()
const submitting = ref(false)
const error = ref<string | null>(null)
const folder = useFolderBrowse({ active: workspace.folderDialogOpen })

watch(
  workspace.folderDialogOpen,
  (open) => {
    error.value = null
    if (open) void nextTick(() => folder.start())
  }
)

async function submit(path?: string): Promise<void> {
  const target = path?.trim() || folder.query.value.trim() || folder.parentPath.value
  if (!target || submitting.value) return
  submitting.value = true
  error.value = null
  try {
    await workspace.addWorkspace(target)
    workspace.folderDialogOpen.value = false
  } catch (cause) {
    error.value = translateApiError(cause instanceof Error ? cause.message : String(cause), t)
  } finally {
    submitting.value = false
  }
}

async function createFolder(): Promise<void> {
  const parentPath = folder.parentPath.value || folder.query.value.trim()
  const name = folder.newFolderName.value.trim()
  if (!parentPath || !name) return
  try {
    const created = (await createFilesystemFolder(parentPath, name)).data.path
    await submit(created)
  } catch (cause) {
    error.value = translateApiError(cause instanceof Error ? cause.message : String(cause), t)
  }
}
</script>

<template>
  <Dialog
    :open="workspace.folderDialogOpen.value"
    class="flex h-[min(42rem,85dvh)] flex-col"
    @close="workspace.folderDialogOpen.value = false"
  >
    <div class="border-b border-border px-4 py-3">
      <h2 class="font-semibold">{{ t('conversation.folderDialogTitle') }}</h2>
      <p class="mt-1 text-xs text-muted-foreground">
        {{ t('conversation.folderDialogDescription') }}
      </p>
    </div>
    <ErrorAlert v-if="error" class="mx-4 mt-3" :message="error" />
    <FolderBrowsePanel
      v-model:query="folder.query.value"
      v-model:new-folder-name="folder.newFolderName.value"
      :parent-path="folder.parentPath.value"
      :current-path="folder.currentDirectoryPath()"
      :entries="folder.entries.value"
      :loading="folder.loading.value"
      :submitting="submitting"
      :error="folder.error.value"
      fill-height
      @open-entry="folder.openEntry"
      @go-parent="folder.goParent"
      @create-folder="createFolder"
      @select="submit"
    />
    <div class="flex justify-end border-t border-border p-3">
      <Button variant="outline" @click="workspace.folderDialogOpen.value = false">
        {{ t('common.cancel') }}
      </Button>
    </div>
  </Dialog>
</template>
