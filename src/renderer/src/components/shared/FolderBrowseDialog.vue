<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import type { BrowseEntry } from '@renderer/api/fs'
import FolderBrowsePanel from '@renderer/components/shared/FolderBrowsePanel.vue'
import Button from '@renderer/components/ui/Button.vue'
import Dialog from '@renderer/components/ui/Dialog.vue'
import Input from '@renderer/components/ui/Input.vue'

defineProps<{
  open: boolean
  query: string
  parentPath: string
  currentPath: string
  entries: BrowseEntry[]
  newFolderName: string
  loading: boolean
  submitting?: boolean
  error: string | null
  selectCurrentLabel?: string
  createFolderLabel?: string
}>()

const emit = defineEmits<{
  close: []
  'update:query': [value: string]
  'update:newFolderName': [value: string]
  goParent: []
  openEntry: [entry: BrowseEntry]
  select: [path: string]
  createFolder: []
}>()

const { t } = useI18n()
</script>

<template>
  <Dialog :open="open" @close="emit('close')">
    <div class="space-y-0">
      <FolderBrowsePanel
        hide-footer
        :query="query"
        :parent-path="parentPath"
        :current-path="currentPath"
        :entries="entries"
        :new-folder-name="newFolderName"
        :loading="loading"
        :submitting="submitting"
        :error="error"
        @update:query="emit('update:query', $event)"
        @update:new-folder-name="emit('update:newFolderName', $event)"
        @go-parent="emit('goParent')"
        @open-entry="emit('openEntry', $event)"
        @select="emit('select', $event)"
      />

      <div class="space-y-3 border-t border-border px-3 py-3 sm:px-4">
        <div class="flex items-center gap-2">
          <Input
            :model-value="newFolderName"
            class="min-w-0 flex-1"
            :placeholder="t('folderPicker.newFolderPlaceholder')"
            @update:model-value="emit('update:newFolderName', $event)"
            @keydown.enter.prevent="emit('createFolder')"
          />
          <Button
            type="button"
            variant="outline"
            class="shrink-0 whitespace-nowrap"
            :disabled="submitting || loading || !newFolderName.trim()"
            @click="emit('createFolder')"
          >
            {{ createFolderLabel ?? t('folderPicker.createAndAdd') }}
          </Button>
        </div>
        <div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
          <span class="truncate text-xs text-muted-foreground">
            {{ t('folderPicker.currentDirectory', { path: currentPath || '—' }) }}
          </span>
          <Button
            type="button"
            class="w-full sm:w-auto"
            :disabled="submitting || loading || !currentPath"
            @click="emit('select', currentPath)"
          >
            {{
              submitting
                ? t('folderPicker.adding')
                : (selectCurrentLabel ?? t('folderPicker.selectCurrent'))
            }}
          </Button>
        </div>
      </div>
    </div>
  </Dialog>
</template>
