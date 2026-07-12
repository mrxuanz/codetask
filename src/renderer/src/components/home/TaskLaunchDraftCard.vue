<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useDebounceFn } from '@vueuse/core'
import type { ConversationCore, ConversationMessage } from '@renderer/api/conversation'
import {
  confirmDraftMessage,
  deleteDraftReference,
  fetchLatestThreadJob,
  importDraftReferences,
  launchJobFromDraft,
  unlockDraftForEdit,
  unlockRequirementsContract,
  updateDraftAbilityCores,
  updateDraftContent,
  updateDraftReferenceDescription,
  uploadDraftReferences
} from '@renderer/api/jobs'
import { fetchThreadMessages } from '@renderer/api/conversation'
import AttachmentPickerButton from '@renderer/components/home/AttachmentPickerButton.vue'
import LocalCorpusPickerDialog from '@renderer/components/create/LocalCorpusPickerDialog.vue'
import Button from '@renderer/components/ui/Button.vue'
import ConfirmDialog from '@renderer/components/ui/ConfirmDialog.vue'
import MarkdownEditor from '@renderer/components/ui/MarkdownEditor.vue'
import { assetUrlWithAuth } from '@renderer/auth/token'
import {
  buildAbilitySelections,
  coreLabel,
  draftReferencesReady,
  formatDateTime,
  mergeDraftReferences,
  referenceRequiresDescription,
  type TaskLaunchDraftPayload,
  type TaskLaunchDraftReference
} from '@renderer/lib/draftForm'
import { cn } from '@renderer/lib/utils'

const props = defineProps<{
  message: ConversationMessage
  threadId: string
  threadMessages: ConversationMessage[]
  cores: ConversationCore[]
  embedded?: boolean
  readOnly?: boolean
  activeStep?: number
}>()

const emit = defineEmits<{
  updated: [message: ConversationMessage]
  planStarted: [jobId: string]
}>()

const { t } = useI18n()

const busy = ref(false)
const confirmingRequirements = ref(false)
const uploadingReferences = ref(false)
const importingReferences = ref(false)
const importDialogOpen = ref(false)
const localCorpusDialogOpen = ref(false)
const selectedImportIds = ref<string[]>([])
const error = ref<string | null>(null)
const launchedLocally = ref(false)
const linkedJobId = ref<string | null>(null)
const savingReferenceId = ref<string | null>(null)
const importDescriptions = ref<Record<string, string>>({})
const abilitySelections = ref<Array<{ abilityCode: string; coreCode: string }>>([])
const uploadInputRef = ref<HTMLInputElement | null>(null)
const contractMarkdown = ref('')
const savingContract = ref(false)
const unlockDialogOpen = ref(false)
const unlockingDraft = ref(false)
const unlockingContract = ref(false)

const payload = computed(() => (props.message.payload ?? {}) as TaskLaunchDraftPayload)
const contractConfirmed = computed(() => payload.value.requirementsContract?.status === 'confirmed')

watch(
  () => payload.value.requirementsContract?.markdown ?? '',
  (markdown) => {
    if (!savingContract.value) contractMarkdown.value = markdown
  },
  { immediate: true }
)

watch(
  () => props.message.payload,
  () => {
    abilitySelections.value = buildAbilitySelections(payload.value)
  },
  { immediate: true }
)

const selectableCores = computed(() => {
  const codes = new Set(props.cores.map((core) => core.code))
  for (const selection of abilitySelections.value) {
    if (selection.coreCode) codes.add(selection.coreCode)
  }
  return Array.from(codes).map((code) => ({
    code,
    label: coreLabel(code, props.cores),
    available: props.cores.find((core) => core.code === code)?.available ?? true
  }))
})

const draftConfirmed = computed(
  () =>
    launchedLocally.value ||
    payload.value.status === 'confirmed' ||
    payload.value.status === 'launched' ||
    Boolean(linkedJobId.value) ||
    Boolean((payload.value as { linkedPlanId?: string }).linkedPlanId)
)
const draftLocked = computed(() => props.readOnly || draftConfirmed.value || busy.value)
const contractEditable = computed(() => !contractConfirmed.value && !draftLocked.value)
const canUnlockContract = computed(() => contractConfirmed.value && !draftLocked.value)

const referencesReady = computed(() => draftReferencesReady(draftReferences.value))

const canLaunch = computed(
  () =>
    contractConfirmed.value &&
    !draftLocked.value &&
    referencesReady.value &&
    abilitySelections.value.every((item) => Boolean(item.coreCode))
)

const showStep = (step: number): boolean =>
  props.activeStep === undefined || props.activeStep === step

const showHeader = computed(() => props.activeStep === undefined)
const showLaunchFooter = computed(() => props.activeStep === undefined || props.activeStep === 4)

const draftReferences = computed(() => mergeDraftReferences(payload.value))

function isLocalCorpusReference(reference: TaskLaunchDraftReference): boolean {
  return reference.source === 'local_corpus' || Boolean(reference.localPath)
}

onMounted(() => {
  void syncLinkedJob()
})

watch(
  () => [props.threadId, props.message.id] as const,
  () => {
    void syncLinkedJob()
  }
)

async function syncLinkedJob(): Promise<void> {
  try {
    const p = payload.value
    if (p.status === 'editing' && !p.linkedPlanId) {
      linkedJobId.value = null
      return
    }
    const res = await fetchLatestThreadJob(props.threadId)
    const job = res.data.job
    if (job?.draftMessageId === props.message.id && job.status !== 'cancelled') {
      linkedJobId.value = job.id
    } else if (job?.draftMessageId === props.message.id) {
      linkedJobId.value = null
    }
  } catch {
    // ignore — card still works from payload status
  }
}

async function handleLocalCorpusAdded(): Promise<void> {
  try {
    const res = await fetchThreadMessages(props.threadId)
    const updated = res.data.messages.find((item) => item.id === props.message.id)
    if (updated) emit('updated', updated)
  } catch {
    // parent may refresh on next action
  }
}

const importableAttachments = computed(() => {
  const existing = new Set(draftReferences.value.map((item) => item.id))
  const items: Array<{ id: string; name: string; kind: 'image' | 'file'; mimeType: string }> = []
  for (const message of props.threadMessages) {
    for (const attachment of message.attachments ?? []) {
      if (existing.has(attachment.id)) continue
      items.push({
        id: attachment.id,
        name: attachment.name,
        kind: attachment.kind,
        mimeType: attachment.mimeType
      })
    }
  }
  return items
})

function openUploadPicker(): void {
  uploadInputRef.value?.click()
}

async function handleUploadReferences(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  input.value = ''
  if (files.length === 0) return

  uploadingReferences.value = true
  error.value = null
  try {
    const res = await uploadDraftReferences(props.threadId, props.message.id, files)
    emit('updated', { ...props.message, payload: res.payload })
  } catch (err) {
    error.value = err instanceof Error ? err.message : t('workspace.draft.uploadFailed')
  } finally {
    uploadingReferences.value = false
  }
}

async function handleDeleteReference(reference: TaskLaunchDraftReference): Promise<void> {
  error.value = null
  try {
    const res = await deleteDraftReference(props.threadId, props.message.id, reference.id)
    emit('updated', { ...props.message, payload: res.data.payload })
  } catch (err) {
    error.value = err instanceof Error ? err.message : t('workspace.draft.deleteFailed')
  }
}

function toggleImportSelection(id: string): void {
  if (selectedImportIds.value.includes(id)) {
    selectedImportIds.value = selectedImportIds.value.filter((item) => item !== id)
  } else {
    selectedImportIds.value = [...selectedImportIds.value, id]
  }
}

async function submitImportReferences(): Promise<void> {
  if (selectedImportIds.value.length === 0) return
  for (const id of selectedImportIds.value) {
    const item = importableAttachments.value.find((entry) => entry.id === id)
    if (item && referenceRequiresDescription(item) && !importDescriptions.value[id]?.trim()) {
      error.value = t('workspace.draft.referenceDescriptionRequired')
      return
    }
  }
  importingReferences.value = true
  error.value = null
  try {
    const res = await importDraftReferences(
      props.threadId,
      props.message.id,
      selectedImportIds.value,
      importDescriptions.value
    )
    emit('updated', { ...props.message, payload: res.data.payload })
    importDialogOpen.value = false
    selectedImportIds.value = []
    importDescriptions.value = {}
  } catch (err) {
    error.value = err instanceof Error ? err.message : t('workspace.draft.importFailed')
  } finally {
    importingReferences.value = false
  }
}

function selectionFor(abilityCode: string): string {
  return abilitySelections.value.find((item) => item.abilityCode === abilityCode)?.coreCode ?? ''
}

async function saveContractMarkdown(): Promise<void> {
  if (!contractEditable.value) return
  const markdown = contractMarkdown.value
  if (markdown === (payload.value.requirementsContract?.markdown ?? '')) return

  savingContract.value = true
  error.value = null
  try {
    const res = await updateDraftContent(props.threadId, props.message.id, {
      requirementsContractMarkdown: markdown
    })
    emit('updated', { ...props.message, payload: res.data.payload })
  } catch (err) {
    error.value = err instanceof Error ? err.message : t('workspace.draft.contractSaveFailed')
  } finally {
    savingContract.value = false
  }
}

const debouncedSaveContract = useDebounceFn(() => {
  void saveContractMarkdown()
}, 600)

watch(contractMarkdown, () => {
  if (contractEditable.value) void debouncedSaveContract()
})

async function handleAbilityChange(abilityCode: string, coreCode: string): Promise<void> {
  if (draftLocked.value) return
  abilitySelections.value = abilitySelections.value.map((item) =>
    item.abilityCode === abilityCode ? { ...item, coreCode } : item
  )
  try {
    const res = await updateDraftAbilityCores(
      props.threadId,
      props.message.id,
      abilitySelections.value
    )
    emit('updated', { ...props.message, payload: res.data.payload })
  } catch {
    // keep local selection even if persist fails
  }
}

async function handleConfirmRequirements(): Promise<void> {
  if (draftLocked.value) return
  confirmingRequirements.value = true
  error.value = null
  try {
    const res = await confirmDraftMessage(props.threadId, props.message.id)
    emit('updated', { ...props.message, payload: res.data.payload })
  } catch (err) {
    error.value = err instanceof Error ? err.message : t('workspace.draft.confirmFailed')
  } finally {
    confirmingRequirements.value = false
  }
}

async function handleUnlockContract(): Promise<void> {
  if (!canUnlockContract.value) return
  unlockingContract.value = true
  error.value = null
  try {
    const res = await unlockRequirementsContract(props.threadId, props.message.id)
    emit('updated', res.data.message)
  } catch (err) {
    error.value = err instanceof Error ? err.message : t('workspace.draft.unlockContractFailed')
  } finally {
    unlockingContract.value = false
  }
}

async function handleSaveReferenceDescription(reference: TaskLaunchDraftReference): Promise<void> {
  if (draftLocked.value) return
  savingReferenceId.value = reference.id
  error.value = null
  try {
    const res = await updateDraftReferenceDescription(
      props.threadId,
      props.message.id,
      reference.id,
      reference.description ?? ''
    )
    emit('updated', { ...props.message, payload: res.data.payload })
  } catch (err) {
    error.value = err instanceof Error ? err.message : t('workspace.draft.referenceSaveFailed')
  } finally {
    savingReferenceId.value = null
  }
}

function updateLocalReferenceDescription(referenceId: string, description: string): void {
  const refs = [...(payload.value.references ?? [])]
  const index = refs.findIndex((item) => item.id === referenceId)
  if (index >= 0) {
    refs[index] = { ...refs[index], description }
  } else {
    const attachment = payload.value.sourceAttachments?.find((item) => item.id === referenceId)
    if (!attachment) return
    refs.push({
      id: attachment.id,
      name: attachment.name,
      mimeType: attachment.mimeType,
      kind: attachment.kind,
      assetUrl: attachment.assetUrl,
      description,
      source: 'message'
    })
  }
  const nextPayload: TaskLaunchDraftPayload = {
    ...payload.value,
    references: refs
  }
  emit('updated', { ...props.message, payload: nextPayload as unknown as Record<string, unknown> })
}

async function handleLaunch(): Promise<void> {
  if (!referencesReady.value) {
    error.value = t('workspace.draft.referenceDescriptionRequired')
    return
  }
  console.log('[CODETASK_DEBUG:planner-sandbox] renderer: generate plan clicked', {
    threadId: props.threadId,
    messageId: props.message.id
  })
  busy.value = true
  launchedLocally.value = true
  error.value = null
  try {
    console.log('[CODETASK_DEBUG:planner-sandbox] renderer: calling launchJobFromDraft')
    const res = await launchJobFromDraft(props.threadId, props.message.id)
    launchedLocally.value = true
    linkedJobId.value = res.data.job.id
    if (res.data.draft) {
      emit('updated', res.data.draft)
    }
    // Stay in create/draft workspace while the tree generates — task list only
    // after the user confirms the plan (planConfirmedAt / launch).
    emit('planStarted', res.data.job.id)
  } catch (err) {
    if (payload.value.status !== 'confirmed' && payload.value.status !== 'launched') {
      launchedLocally.value = false
    }
    error.value = err instanceof Error ? err.message : t('workspace.draft.launchFailed')
  } finally {
    busy.value = false
  }
}

async function handleUnlockDraft(): Promise<void> {
  unlockingDraft.value = true
  error.value = null
  try {
    const res = await unlockDraftForEdit(props.threadId, props.message.id)
    launchedLocally.value = false
    linkedJobId.value = null
    unlockDialogOpen.value = false
    emit('updated', res.data.draft)
  } catch (err) {
    error.value = err instanceof Error ? err.message : t('workspace.draft.unlockFailed')
  } finally {
    unlockingDraft.value = false
  }
}
</script>

<template>
  <section
    class="w-full min-w-0 rounded-xl border border-border bg-card p-4 text-sm shadow-sm"
    :class="draftLocked && !readOnly ? 'pointer-events-none opacity-75' : ''"
  >
    <div v-if="showHeader" class="mb-4">
      <div class="mb-1 flex flex-wrap items-center gap-2">
        <span class="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          {{ t('workspace.draft.badge') }}
        </span>
        <span
          :class="
            cn(
              'rounded-full px-2 py-0.5 text-[10px] font-medium uppercase',
              draftConfirmed
                ? 'bg-emerald-500/10 text-emerald-700'
                : 'bg-amber-500/10 text-amber-700'
            )
          "
        >
          {{
            draftConfirmed
              ? t('workspace.draft.statusLaunched')
              : t('workspace.draft.statusPending')
          }}
        </span>
      </div>
      <h2 class="text-base font-semibold">{{ payload.title || message.content }}</h2>
      <p v-if="payload.summary" class="mt-1 whitespace-pre-wrap text-muted-foreground">
        {{ payload.summary }}
      </p>
    </div>

    <div
      v-if="showStep(1) && payload.requirementsContract?.markdown"
      class="mb-4 rounded-lg border border-border/70 bg-muted/20 p-3"
    >
      <div class="mb-2 flex flex-wrap items-center justify-between gap-2">
        <span class="text-xs font-medium text-muted-foreground">{{
          t('workspace.draft.requirementsContract')
        }}</span>
        <span
          :class="
            cn(
              'rounded-full px-2 py-0.5 text-[10px] font-medium',
              contractConfirmed
                ? 'bg-emerald-500/10 text-emerald-700'
                : 'bg-amber-500/10 text-amber-700'
            )
          "
        >
          {{
            contractConfirmed ? t('workspace.draft.confirmed') : t('workspace.draft.pendingConfirm')
          }}
        </span>
      </div>
      <MarkdownEditor
        v-model="contractMarkdown"
        min-height="14rem"
        max-height="min(32rem, 60vh)"
        :readonly="!contractEditable"
        :preview-only="readOnly"
        :saving="savingContract"
        @blur="saveContractMarkdown"
      />
      <p
        v-if="contractConfirmed && payload.requirementsContract.confirmedAt"
        class="mt-2 text-xs text-muted-foreground"
      >
        {{
          t('workspace.draft.confirmedAt', {
            time: formatDateTime(payload.requirementsContract.confirmedAt)
          })
        }}
      </p>
      <Button
        v-if="canUnlockContract"
        type="button"
        size="sm"
        variant="outline"
        class="mt-3"
        :disabled="unlockingContract"
        @click="handleUnlockContract"
      >
        {{
          unlockingContract
            ? t('workspace.draft.unlockingContract')
            : t('workspace.draft.unlockContract')
        }}
      </Button>
      <Button
        v-else-if="!draftLocked && !contractConfirmed"
        type="button"
        size="sm"
        variant="outline"
        class="mt-3"
        :disabled="confirmingRequirements"
        @click="handleConfirmRequirements"
      >
        {{
          confirmingRequirements
            ? t('workspace.draft.confirming')
            : t('workspace.draft.confirmContract')
        }}
      </Button>
    </div>

    <div
      v-if="showStep(2) && payload.abilities?.length"
      class="mb-4 rounded-lg border border-border/70 p-3"
    >
      <div class="text-xs font-medium text-muted-foreground">
        {{ t('workspace.draft.abilitiesCli') }}
      </div>
      <div class="mt-3 space-y-3">
        <div
          v-for="ability in payload.abilities"
          :key="ability.abilityCode"
          class="rounded-md bg-muted/30 p-3"
        >
          <div class="font-medium">{{ ability.label || ability.abilityCode }}</div>
          <p class="mt-1 text-xs text-muted-foreground">
            {{ ability.reason || ability.description }}
          </p>
          <select
            class="mt-2 w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs"
            :disabled="draftLocked"
            :value="selectionFor(ability.abilityCode)"
            @change="
              handleAbilityChange(ability.abilityCode, ($event.target as HTMLSelectElement).value)
            "
          >
            <option value="">{{ t('workspace.draft.selectCli') }}</option>
            <option v-for="core in selectableCores" :key="core.code" :value="core.code">
              {{ core.label
              }}{{ core.available ? '' : ` (${t('workspace.draft.cliUnavailable')})` }}
            </option>
          </select>
        </div>
      </div>
    </div>

    <div
      v-if="showStep(3)"
      class="mb-4 min-w-0 overflow-hidden rounded-lg border border-border/70 p-3"
    >
      <div class="mb-2 flex flex-wrap items-center justify-between gap-2">
        <span class="text-xs font-medium text-muted-foreground">{{
          t('workspace.draft.references')
        }}</span>
        <div v-if="!draftLocked" class="flex flex-wrap gap-2">
          <input
            ref="uploadInputRef"
            type="file"
            multiple
            class="hidden"
            @change="handleUploadReferences"
          />
          <AttachmentPickerButton
            :disabled="uploadingReferences"
            :title="t('workspace.draft.uploadReferences')"
            @click="openUploadPicker"
          />
          <Button
            type="button"
            size="sm"
            variant="outline"
            :disabled="importableAttachments.length === 0"
            @click="importDialogOpen = true"
          >
            {{ t('workspace.draft.importFromChat') }}
          </Button>
          <Button type="button" size="sm" variant="outline" @click="localCorpusDialogOpen = true">
            {{ t('workspace.draft.localCorpusAdd') }}
          </Button>
        </div>
      </div>

      <p class="text-xs text-muted-foreground">
        {{ t('workspace.draft.referencesHint') }}
      </p>

      <p v-if="draftReferences.length === 0" class="text-xs text-muted-foreground">
        {{ t('workspace.draft.noReferences') }}
      </p>

      <div v-else class="space-y-3">
        <div
          v-for="reference in draftReferences"
          :key="reference.id"
          class="space-y-3 rounded-lg border border-border/60 bg-muted/10 p-3"
        >
          <div class="flex items-start gap-3">
            <div
              v-if="isLocalCorpusReference(reference)"
              class="flex size-16 shrink-0 flex-col items-center justify-center gap-1 rounded-md border border-border/60 bg-muted/30 px-1 text-center text-[10px] text-muted-foreground"
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
              v-else
              :href="assetUrlWithAuth(reference.assetUrl)"
              target="_blank"
              rel="noreferrer"
              class="block shrink-0 overflow-hidden rounded-md border border-border/60"
            >
              <img
                v-if="reference.kind === 'image'"
                :src="assetUrlWithAuth(reference.assetUrl)"
                :alt="reference.name"
                class="size-16 object-cover"
              />
              <div
                v-else
                class="flex size-16 flex-col items-center justify-center gap-1 px-1 text-center text-[10px] text-muted-foreground"
              >
                <svg viewBox="0 0 24 24" class="size-4" aria-hidden fill="none">
                  <path
                    d="M7 4h7l5 5v11a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z"
                    stroke="currentColor"
                    stroke-width="1.5"
                  />
                  <path d="M14 4v5h5" stroke="currentColor" stroke-width="1.5" />
                </svg>
              </div>
            </a>
            <div class="min-w-0 flex-1">
              <div class="flex items-start justify-between gap-3">
                <div class="min-w-0">
                  <div class="truncate font-medium">{{ reference.name }}</div>
                  <div class="text-[10px] uppercase text-muted-foreground">
                    {{ isLocalCorpusReference(reference) ? 'directory' : reference.kind }}
                  </div>
                  <p
                    v-if="isLocalCorpusReference(reference) && reference.localPath"
                    class="mt-1 truncate font-mono text-[10px] text-muted-foreground"
                  >
                    {{ reference.localPath }}
                  </p>
                </div>
                <div class="flex shrink-0 items-center gap-2">
                  <a
                    v-if="!isLocalCorpusReference(reference)"
                    :href="assetUrlWithAuth(reference.assetUrl)"
                    target="_blank"
                    rel="noreferrer"
                    class="text-xs text-primary underline"
                  >
                    {{ t('common.preview') }}
                  </a>
                  <Button
                    v-if="!draftLocked"
                    type="button"
                    size="sm"
                    variant="ghost"
                    class="h-7 px-2 text-xs"
                    @click="handleDeleteReference(reference)"
                  >
                    {{ t('common.delete') }}
                  </Button>
                </div>
              </div>
              <p
                v-if="!referenceRequiresDescription(reference) && reference.description"
                class="mt-2 text-xs text-muted-foreground"
              >
                {{ reference.description }}
              </p>
            </div>
          </div>
          <div v-if="referenceRequiresDescription(reference)" class="space-y-1.5">
            <label class="block text-xs text-muted-foreground">
              {{ t('workspace.draft.referenceDescriptionLabel') }}
              <span class="text-destructive">*</span>
            </label>
            <textarea
              :value="reference.description ?? ''"
              :placeholder="t('workspace.draft.referenceDescriptionPlaceholder')"
              rows="2"
              class="w-full resize-y rounded-md border border-border/50 bg-background px-3 py-2 text-sm leading-relaxed outline-none transition-colors placeholder:text-muted-foreground/70 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
              :disabled="draftLocked || savingReferenceId === reference.id"
              @input="
                updateLocalReferenceDescription(
                  reference.id,
                  ($event.target as HTMLTextAreaElement).value
                )
              "
              @blur="
                handleSaveReferenceDescription({
                  ...reference,
                  description: ($event.target as HTMLTextAreaElement).value
                })
              "
            />
          </div>
        </div>
      </div>
    </div>

    <LocalCorpusPickerDialog
      v-model:open="localCorpusDialogOpen"
      :thread-id="threadId"
      :message-id="message.id"
      @added="handleLocalCorpusAdded"
    />

    <div
      v-if="importDialogOpen"
      class="pointer-events-auto fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      @click.self="importDialogOpen = false"
    >
      <div
        class="max-h-[80vh] w-full max-w-lg overflow-auto rounded-xl border border-border bg-card p-4 shadow-lg"
      >
        <h3 class="text-sm font-semibold">{{ t('workspace.draft.importDialogTitle') }}</h3>
        <p v-if="importableAttachments.length === 0" class="mt-3 text-xs text-muted-foreground">
          {{ t('workspace.draft.importDialogEmpty') }}
        </p>
        <div v-else class="mt-3 space-y-3">
          <div
            v-for="item in importableAttachments"
            :key="item.id"
            class="rounded-md border border-border/60 p-3"
          >
            <label class="flex cursor-pointer items-center gap-2 text-xs">
              <input
                type="checkbox"
                :checked="selectedImportIds.includes(item.id)"
                @change="toggleImportSelection(item.id)"
              />
              <span class="font-medium">{{ item.name }}</span>
              <span class="text-muted-foreground">({{ item.kind }})</span>
            </label>
            <div
              v-if="selectedImportIds.includes(item.id) && referenceRequiresDescription(item)"
              class="mt-3 space-y-1.5"
            >
              <label class="block text-xs text-muted-foreground">
                {{ t('workspace.draft.referenceDescriptionLabel') }}
                <span class="text-destructive">*</span>
              </label>
              <textarea
                :value="importDescriptions[item.id] ?? ''"
                :placeholder="t('workspace.draft.referenceDescriptionPlaceholder')"
                rows="2"
                class="w-full resize-y rounded-md border border-border/50 bg-background px-3 py-2 text-sm leading-relaxed outline-none transition-colors placeholder:text-muted-foreground/70 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
                @input="importDescriptions[item.id] = ($event.target as HTMLTextAreaElement).value"
              />
            </div>
          </div>
        </div>
        <div class="mt-4 flex justify-end gap-2">
          <Button type="button" variant="outline" size="sm" @click="importDialogOpen = false">
            {{ t('common.cancel') }}
          </Button>
          <Button
            type="button"
            size="sm"
            :disabled="importingReferences || selectedImportIds.length === 0"
            @click="submitImportReferences"
          >
            {{
              importingReferences
                ? t('workspace.draft.importing')
                : t('workspace.draft.importSelected')
            }}
          </Button>
        </div>
      </div>
    </div>

    <div
      v-if="showLaunchFooter"
      class="flex items-center justify-between gap-3 border-t border-border pt-3"
      :class="draftLocked ? 'pointer-events-auto' : ''"
    >
      <div class="text-xs text-muted-foreground">
        <template v-if="draftConfirmed">
          {{ t('workspace.draftPanel.confirmedHint') }}
        </template>
        <template v-else-if="!referencesReady && draftReferences.length > 0">
          {{ t('workspace.draft.referenceDescriptionRequired') }}
        </template>
        <template v-else-if="contractConfirmed">
          {{ t('workspace.draft.readyHint') }}
        </template>
        <template v-else>
          {{ t('workspace.draft.pendingHint') }}
        </template>
      </div>
      <Button
        v-if="canLaunch && !draftLocked"
        type="button"
        size="sm"
        :disabled="busy"
        @click="handleLaunch"
      >
        {{ busy ? t('workspace.draft.submitting') : t('workspace.draftPanel.confirmDraft') }}
      </Button>
      <Button
        v-else-if="draftLocked && !readOnly"
        type="button"
        variant="outline"
        size="sm"
        class="pointer-events-auto"
        @click="unlockDialogOpen = true"
      >
        {{ t('workspace.draftPanel.unlockDraft') }}
      </Button>
    </div>

    <ConfirmDialog
      :open="unlockDialogOpen"
      :title="t('workspace.draftPanel.unlockDraftTitle')"
      :message="t('workspace.draftPanel.unlockDraftMessage')"
      :confirm-label="t('workspace.draftPanel.unlockDraftConfirm')"
      :loading="unlockingDraft"
      @close="unlockDialogOpen = false"
      @confirm="handleUnlockDraft"
    />

    <p v-if="error" class="mt-2 text-xs text-destructive pointer-events-auto">{{ error }}</p>
  </section>
</template>
