<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { DraftReference } from '@shared/reference-corpus'
import {
  fetchDesignSessionReferences,
  removeDesignSessionReference,
  updateDesignSessionReference
} from '@renderer/api/design-sessions'
import LocalCorpusPickerDialog from '@renderer/components/create/LocalCorpusPickerDialog.vue'
import AttachmentPickerButton from '@renderer/components/home/AttachmentPickerButton.vue'
import Button from '@renderer/components/ui/Button.vue'
import Dialog from '@renderer/components/ui/Dialog.vue'
import { assetUrlWithAuth } from '@renderer/auth/token'
import { referenceRequiresDescription } from '@renderer/lib/draftForm'

const props = defineProps<{
  threadId: string
  designSessionId: string
  editable?: boolean
  stale?: boolean
  freezing?: boolean
}>()

const emit = defineEmits<{
  changed: []
  refreeze: []
}>()

const { t } = useI18n()

const references = ref<DraftReference[]>([])
const loading = ref(false)
const error = ref<string | null>(null)
const localCorpusDialogOpen = ref(false)
const uploading = ref(false)
const savingRefId = ref<string | null>(null)
const uploadInputRef = ref<HTMLInputElement | null>(null)
const uploadDialogOpen = ref(false)
const uploadFiles = ref<File[]>([])
const uploadDescription = ref('')
const uploadDescriptionError = ref<string | null>(null)

const editable = computed(() => props.editable !== false)

async function loadReferences(): Promise<void> {
  loading.value = true
  error.value = null
  try {
    const res = await fetchDesignSessionReferences(props.threadId, props.designSessionId)
    references.value = res.data.references
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    loading.value = false
  }
}

function isLocalCorpus(reference: DraftReference): boolean {
  return reference.source === 'local_corpus'
}

async function handleDelete(reference: DraftReference): Promise<void> {
  error.value = null
  try {
    await removeDesignSessionReference(props.threadId, props.designSessionId, reference.id)
    await loadReferences()
    emit('changed')
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  }
}

async function handleSaveDescription(
  reference: DraftReference,
  description: string
): Promise<void> {
  const trimmed = description.trim()
  if (referenceRequiresDescription(reference) && !trimmed) return
  if ((reference.description ?? '').trim() === trimmed) return
  savingRefId.value = reference.id
  error.value = null
  try {
    await updateDesignSessionReference(props.threadId, props.designSessionId, reference.id, {
      description: trimmed
    })
    await loadReferences()
    emit('changed')
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    savingRefId.value = null
  }
}

function openUploadPicker(): void {
  uploadInputRef.value?.click()
}

async function handleUpload(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const files = input.files ? Array.from(input.files) : []
  input.value = ''
  if (files.length === 0) return
  uploadFiles.value = files
  uploadDescription.value = ''
  uploadDescriptionError.value = null
  uploadDialogOpen.value = true
}

function closeUploadDialog(): void {
  if (uploading.value) return
  resetUploadDialog()
}

function resetUploadDialog(): void {
  uploadDialogOpen.value = false
  uploadFiles.value = []
  uploadDescription.value = ''
  uploadDescriptionError.value = null
}

async function submitUpload(): Promise<void> {
  const description = uploadDescription.value.trim()
  if (!description) {
    uploadDescriptionError.value = t('workspace.draft.referenceDescriptionRequired')
    return
  }
  const files = [...uploadFiles.value]
  if (files.length === 0) {
    closeUploadDialog()
    return
  }
  uploading.value = true
  error.value = null
  uploadDescriptionError.value = null
  try {
    const { uploadDesignSessionReference } = await import('@renderer/api/design-sessions')
    for (const file of files) {
      await uploadDesignSessionReference(props.threadId, props.designSessionId, file, description)
    }
    await loadReferences()
    emit('changed')
    resetUploadDialog()
  } catch (err) {
    uploadDescriptionError.value = err instanceof Error ? err.message : String(err)
  } finally {
    uploading.value = false
  }
}

function handleCorpusAdded(): void {
  void loadReferences().then(() => emit('changed'))
}

onMounted(() => {
  void loadReferences()
})

watch(
  () => [props.threadId, props.designSessionId] as const,
  () => {
    void loadReferences()
  }
)
</script>

<template>
  <div class="rounded-lg border border-border/70 p-3">
    <div class="mb-2 flex flex-wrap items-center justify-between gap-2">
      <span class="text-xs font-medium text-muted-foreground">
        {{ t('workspace.draft.references') }}
      </span>
      <div v-if="editable" class="flex flex-wrap gap-2">
        <input ref="uploadInputRef" type="file" multiple class="hidden" @change="handleUpload" />
        <AttachmentPickerButton
          :disabled="uploading"
          :title="t('workspace.draft.uploadReferences')"
          @click="openUploadPicker"
        />
        <Button type="button" size="sm" variant="outline" @click="localCorpusDialogOpen = true">
          {{ t('workspace.draft.localCorpusAdd') }}
        </Button>
      </div>
    </div>

    <div
      v-if="stale"
      class="mb-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2.5"
    >
      <p class="text-xs leading-relaxed text-amber-950 dark:text-amber-100">
        {{ t('workspace.draftPanel.referenceManifestStaleHint') }}
      </p>
      <Button
        type="button"
        size="sm"
        variant="outline"
        class="mt-2 border-amber-500/50"
        :disabled="freezing"
        @click="emit('refreeze')"
      >
        {{
          freezing
            ? t('workspace.draftPanel.refreezingCorpus')
            : t('workspace.draftPanel.refreezeCorpus')
        }}
      </Button>
    </div>

    <p class="text-xs text-muted-foreground">{{ t('workspace.draftPanel.corpusPlanEditHint') }}</p>
    <p v-if="loading" class="mt-2 text-xs text-muted-foreground">
      {{ t('workspace.draftPanel.corpusLoading') }}
    </p>
    <p v-else-if="references.length === 0" class="mt-2 text-xs text-muted-foreground">
      {{ t('workspace.draft.noReferences') }}
    </p>

    <div v-else class="mt-3 space-y-3">
      <div
        v-for="reference in references"
        :key="reference.id"
        class="space-y-2 rounded-lg border border-border/60 bg-muted/10 p-3"
      >
        <div class="flex items-start gap-3">
          <div
            v-if="isLocalCorpus(reference)"
            class="flex size-14 shrink-0 flex-col items-center justify-center gap-1 rounded-md border border-border/60 bg-muted/30 px-1 text-center text-[10px] text-muted-foreground"
          >
            <svg viewBox="0 0 24 24" class="size-5" aria-hidden fill="none">
              <path
                d="M3 7a2 2 0 0 1 2-2h5l2 2h9a1 1 0 0 1 1 1v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"
                stroke="currentColor"
                stroke-width="1.5"
              />
            </svg>
            <span>{{ t('workspace.draft.localCorpusBadge') }}</span>
          </div>
          <a
            v-else-if="reference.assetUrl"
            :href="assetUrlWithAuth(reference.assetUrl)"
            target="_blank"
            rel="noreferrer"
            class="block shrink-0 overflow-hidden rounded-md border border-border/60"
          >
            <img
              v-if="reference.kind === 'image'"
              :src="assetUrlWithAuth(reference.assetUrl)"
              :alt="reference.name"
              class="size-14 object-cover"
            />
          </a>
          <div class="min-w-0 flex-1">
            <div class="flex items-start justify-between gap-2">
              <div class="min-w-0">
                <div class="truncate text-sm font-medium">{{ reference.name }}</div>
                <div class="text-[10px] uppercase text-muted-foreground">{{ reference.kind }}</div>
                <p
                  v-if="isLocalCorpus(reference) && reference.localPath"
                  class="mt-1 truncate font-mono text-[10px] text-muted-foreground"
                >
                  {{ reference.localPath }}
                </p>
              </div>
              <Button
                v-if="editable"
                type="button"
                size="sm"
                variant="ghost"
                class="h-7 shrink-0 px-2 text-xs"
                @click="handleDelete(reference)"
              >
                {{ t('common.delete') }}
              </Button>
            </div>
          </div>
        </div>
        <div v-if="editable || reference.description" class="space-y-1.5">
          <label class="block text-xs text-muted-foreground">
            {{ t('workspace.draft.referenceDescriptionLabel') }}
            <span v-if="referenceRequiresDescription(reference)" class="text-destructive">*</span>
          </label>
          <textarea
            v-if="editable"
            :value="reference.description ?? ''"
            rows="2"
            class="w-full resize-y rounded-md border border-border/50 bg-background px-3 py-2 text-sm leading-relaxed outline-none transition-colors placeholder:text-muted-foreground/70 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
            :placeholder="t('workspace.draft.referenceDescriptionPlaceholder')"
            :disabled="savingRefId === reference.id"
            @blur="handleSaveDescription(reference, ($event.target as HTMLTextAreaElement).value)"
          />
          <p v-else class="text-xs text-muted-foreground">{{ reference.description }}</p>
        </div>
      </div>
    </div>

    <p v-if="error" class="mt-2 text-xs text-destructive">{{ error }}</p>

    <LocalCorpusPickerDialog
      v-model:open="localCorpusDialogOpen"
      :thread-id="threadId"
      :design-session-id="designSessionId"
      @added="handleCorpusAdded"
    />

    <Dialog :open="uploadDialogOpen" @close="closeUploadDialog">
      <div class="border-b border-border px-4 py-3">
        <h3 class="text-sm font-semibold">{{ t('workspace.draft.referenceUploadDialogTitle') }}</h3>
        <p class="mt-1 text-xs text-muted-foreground">
          {{ t('workspace.draft.referenceUploadDialogHint') }}
        </p>
      </div>
      <div class="space-y-4 px-4 py-4">
        <div class="rounded-md bg-muted/40 px-3 py-2">
          <p class="truncate text-xs text-muted-foreground">
            {{ uploadFiles.map((file) => file.name).join(', ') }}
          </p>
        </div>
        <div class="space-y-1.5">
          <label class="block text-xs text-muted-foreground">
            {{ t('workspace.draft.referenceDescriptionLabel') }}
            <span class="text-destructive">*</span>
          </label>
          <textarea
            v-model="uploadDescription"
            rows="3"
            class="w-full resize-y rounded-md border border-border/50 bg-background px-3 py-2 text-sm leading-relaxed outline-none transition-colors placeholder:text-muted-foreground/70 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
            :placeholder="t('workspace.draft.referenceDescriptionPlaceholder')"
          />
        </div>
        <p v-if="uploadDescriptionError" class="text-xs text-destructive">
          {{ uploadDescriptionError }}
        </p>
        <div class="flex justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            :disabled="uploading"
            @click="closeUploadDialog"
          >
            {{ t('common.cancel') }}
          </Button>
          <Button type="button" size="sm" :disabled="uploading" @click="submitUpload">
            {{
              uploading
                ? t('workspace.draft.uploadingReferences')
                : t('workspace.draft.uploadReferences')
            }}
          </Button>
        </div>
      </div>
    </Dialog>
  </div>
</template>
