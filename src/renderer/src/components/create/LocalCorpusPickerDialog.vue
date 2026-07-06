<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { addLocalCorpusDraftReference } from '@renderer/api/jobs'
import { addDesignSessionLocalCorpus } from '@renderer/api/design-sessions'
import { useFolderBrowse } from '@renderer/composables/useFolderBrowse'
import FolderBrowsePanel from '@renderer/components/shared/FolderBrowsePanel.vue'
import Button from '@renderer/components/ui/Button.vue'
import Dialog from '@renderer/components/ui/Dialog.vue'
import Input from '@renderer/components/ui/Input.vue'

const props = defineProps<{
  open: boolean
  threadId: string
  messageId?: string
  designSessionId?: string
}>()

const emit = defineEmits<{
  'update:open': [value: boolean]
  added: []
}>()

const { t } = useI18n()
const openModel = computed({
  get: () => props.open,
  set: (value: boolean) => emit('update:open', value)
})

const step = ref<'browse' | 'details'>('browse')
const selectedPath = ref('')
const name = ref('')
const description = ref('')
const submitting = ref(false)
const formError = ref<string | null>(null)

const active = openModel
const {
  query,
  parentPath,
  entries,
  newFolderName,
  loading,
  error: browseError,
  reset: resetBrowse,
  currentDirectoryPath,
  openEntry,
  goParent,
  start: startBrowse
} = useFolderBrowse({ active })

function reset(): void {
  step.value = 'browse'
  selectedPath.value = ''
  name.value = ''
  description.value = ''
  submitting.value = false
  formError.value = null
  resetBrowse()
}

function close(): void {
  openModel.value = false
}

function basename(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, '')
  const parts = trimmed.split(/[/\\]/)
  return parts[parts.length - 1] || trimmed
}

function handleSelectPath(path: string): void {
  const trimmed = path.trim()
  if (!trimmed) {
    formError.value = t('folderPicker.selectRequired')
    return
  }
  selectedPath.value = trimmed
  name.value = basename(trimmed)
  description.value = ''
  formError.value = null
  step.value = 'details'
}

async function submitReference(): Promise<void> {
  const desc = description.value.trim()
  if (!desc) {
    formError.value = t('workspace.draft.localCorpusDescriptionRequired')
    return
  }
  if (!props.designSessionId && !props.messageId) {
    formError.value = t('workspace.draft.localCorpusAddFailed')
    return
  }
  submitting.value = true
  formError.value = null
  try {
    if (props.designSessionId) {
      await addDesignSessionLocalCorpus(props.threadId, props.designSessionId, {
        localPath: selectedPath.value,
        name: name.value.trim() || basename(selectedPath.value),
        description: desc,
        kind: 'directory'
      })
    } else {
      await addLocalCorpusDraftReference(props.threadId, props.messageId!, {
        localPath: selectedPath.value,
        name: name.value.trim() || basename(selectedPath.value),
        description: desc,
        kind: 'directory'
      })
    }
    emit('added')
    close()
  } catch (err) {
    formError.value = err instanceof Error ? err.message : t('workspace.draft.localCorpusAddFailed')
  } finally {
    submitting.value = false
  }
}

watch(openModel, (isOpen) => {
  if (!isOpen) {
    reset()
    return
  }
  startBrowse()
})
</script>

<template>
  <Dialog :open="openModel" @close="close">
    <div class="space-y-0">
      <div class="border-b border-border px-4 py-3">
        <h3 class="text-sm font-semibold">{{ t('workspace.draft.localCorpusDialogTitle') }}</h3>
        <p class="mt-1 text-xs text-muted-foreground">
          {{ t('workspace.draft.localCorpusDialogHint') }}
        </p>
      </div>

      <FolderBrowsePanel
        v-if="step === 'browse'"
        v-model:query="query"
        v-model:new-folder-name="newFolderName"
        :parent-path="parentPath"
        :current-path="currentDirectoryPath()"
        :entries="entries"
        :loading="loading"
        :submitting="submitting"
        :error="browseError"
        :show-create-folder="false"
        :select-current-label="t('workspace.draft.localCorpusSelectDirectory')"
        @go-parent="goParent()"
        @open-entry="openEntry($event)"
        @select="handleSelectPath"
      />

      <div v-else class="space-y-4 px-4 py-4">
        <p v-if="formError" class="text-xs text-destructive">{{ formError }}</p>
        <div class="space-y-1.5">
          <label class="block text-xs text-muted-foreground">
            {{ t('workspace.draft.localCorpusPathLabel') }}
          </label>
          <p class="truncate rounded-md bg-muted/40 px-3 py-2 font-mono text-xs">
            {{ selectedPath }}
          </p>
        </div>
        <div class="space-y-1.5">
          <label class="block text-xs text-muted-foreground">
            {{ t('workspace.draft.localCorpusNameLabel') }}
          </label>
          <Input v-model="name" :placeholder="t('workspace.draft.localCorpusNamePlaceholder')" />
        </div>
        <div class="space-y-1.5">
          <label class="block text-xs text-muted-foreground">
            {{ t('workspace.draft.referenceDescriptionLabel') }}
            <span class="text-destructive">*</span>
          </label>
          <textarea
            v-model="description"
            rows="3"
            class="w-full resize-y rounded-md border border-border/50 bg-background px-3 py-2 text-sm leading-relaxed outline-none transition-colors placeholder:text-muted-foreground/70 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
            :placeholder="t('workspace.draft.localCorpusDescriptionPlaceholder')"
          />
        </div>
        <div class="flex justify-end gap-2">
          <Button type="button" variant="outline" size="sm" @click="step = 'browse'">
            {{ t('common.back') }}
          </Button>
          <Button type="button" size="sm" :disabled="submitting" @click="submitReference">
            {{
              submitting
                ? t('workspace.draft.localCorpusAdding')
                : t('workspace.draft.localCorpusAdd')
            }}
          </Button>
        </div>
      </div>
    </div>
  </Dialog>
</template>
