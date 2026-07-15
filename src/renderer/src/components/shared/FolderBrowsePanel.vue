<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import Button from '@renderer/components/ui/Button.vue'
import ErrorAlert from '@renderer/components/ui/ErrorAlert.vue'
import Input from '@renderer/components/ui/Input.vue'
import Spinner from '@renderer/components/ui/Spinner.vue'
import type { BrowseEntry } from '@renderer/api/fs'
import { cn } from '@renderer/lib/utils'

defineProps<{
  query: string
  parentPath: string
  currentPath: string
  entries: BrowseEntry[]
  newFolderName: string
  loading: boolean
  submitting?: boolean
  error: string | null
  showCreateFolder?: boolean
  selectCurrentLabel?: string
  createFolderLabel?: string
  /** Hide footer (create folder + select current); host renders its own footer. */
  hideFooter?: boolean
  /** Fill available height; list scrolls while footer stays visible (dialog mode). */
  fillHeight?: boolean
}>()

const emit = defineEmits<{
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
  <div :class="cn('flex flex-col', fillHeight && 'min-h-0 flex-1')">
    <div class="shrink-0 space-y-2 border-b border-border px-3 py-3 sm:px-4">
      <div class="flex items-center gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          :disabled="loading || !currentPath"
          :aria-label="t('folderPicker.goParent')"
          @click="emit('goParent')"
        >
          ←
        </Button>
        <Input
          :model-value="query"
          :placeholder="t('folderPicker.pathPlaceholder')"
          class="border-0 px-0 shadow-none focus-visible:ring-0"
          @update:model-value="emit('update:query', $event)"
          @keydown.enter.prevent="emit('select', currentPath)"
        />
      </div>
      <p v-if="parentPath" class="truncate text-xs text-muted-foreground">{{ parentPath }}</p>
      <!-- Keep create-folder in the sticky header so it never gets clipped by the list. -->
      <div
        v-if="showCreateFolder !== false && hideFooter !== true"
        class="flex flex-col gap-2 sm:flex-row sm:items-center"
      >
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
          class="w-full shrink-0 whitespace-nowrap sm:w-auto"
          :disabled="submitting || !newFolderName.trim()"
          @click="emit('createFolder')"
        >
          {{ createFolderLabel ?? t('folderPicker.createAndAdd') }}
        </Button>
      </div>
    </div>

    <div
      :class="
        cn('space-y-2 overflow-y-auto px-3 py-3 sm:px-4', fillHeight ? 'min-h-0 flex-1' : 'max-h-72')
      "
    >
      <ErrorAlert v-if="error" :message="error" />
      <div class="flex items-center justify-between">
        <Button
          type="button"
          variant="outline"
          size="sm"
          :disabled="loading || !currentPath"
          @click="emit('goParent')"
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
              @click="emit('openEntry', entry)"
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
              @click="emit('select', entry.path)"
            >
              {{ t('folderPicker.select') }}
            </Button>
          </div>
        </li>
      </ul>
    </div>

    <div
      v-if="hideFooter !== true"
      class="shrink-0 space-y-3 border-t border-border px-3 py-3 sm:px-4"
    >
      <div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
        <span class="min-w-0 break-all text-xs text-muted-foreground sm:truncate">
          {{ t('folderPicker.currentDirectory', { path: currentPath || '—' }) }}
        </span>
        <Button
          type="button"
          class="w-full shrink-0 sm:w-auto"
          :disabled="submitting || !currentPath"
          @click="emit('select', currentPath)"
        >
          {{ selectCurrentLabel ?? t('folderPicker.selectCurrent') }}
        </Button>
      </div>
    </div>
  </div>
</template>
