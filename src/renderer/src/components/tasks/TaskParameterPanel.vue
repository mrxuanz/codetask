<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { JobReferenceManifestDto } from '@shared/contracts/jobs'
import type { TaskEvidenceDto } from '@shared/contracts/evidence'
import EditablePlanField from '@renderer/components/tasks/EditablePlanField.vue'
import Button from '@renderer/components/ui/Button.vue'
import type { UnifiedTaskNode } from '@renderer/lib/jobProgress'
import { resolveTaskCli } from '@renderer/lib/jobProgress'
import { formatTurnError } from '@renderer/i18n/formatTurnError'
import { assetUrlWithAuth } from '@renderer/auth/token'
import { fetchTaskEvidenceDetail } from '@renderer/api/jobs'

const props = defineProps<{
  task: UnifiedTaskNode | null
  threadId?: string | null
  jobId?: string | null
  abilities?: Array<{ abilityCode: string; recommendedCoreCode?: string }>
  referenceManifest?: JobReferenceManifestDto | null
  fieldsEditable?: boolean
  saving?: boolean
}>()

const emit = defineEmits<{
  saveField: [
    payload: { field: 'description' | 'successCriteria' | 'contextMarkdown'; value: string }
  ]
  saveReferences: [payload: { referenceIds: string[]; referenceReason: string }]
}>()

const { t } = useI18n()

const selectedReferenceIds = ref<string[]>([])
const referenceReasonDraft = ref('')

watch(
  () => [props.task?.id, props.task?.referenceIds, props.task?.referenceReason] as const,
  () => {
    selectedReferenceIds.value = [...(props.task?.referenceIds ?? [])]
    referenceReasonDraft.value = props.task?.referenceReason ?? ''
  },
  { immediate: true }
)

const referencesEditable = computed(() =>
  Boolean(props.fieldsEditable && props.referenceManifest?.references.length)
)

const displayReferences = computed(() => {
  if (props.task?.assignedReferences?.length) return props.task.assignedReferences
  if (!props.referenceManifest || !props.task?.referenceIds?.length) return []
  const byId = new Map(props.referenceManifest.references.map((item) => [item.id, item]))
  return props.task.referenceIds
    .map((id) => byId.get(id))
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
    .map((item) => ({
      id: item.id,
      name: item.name,
      kind: item.kind,
      description: item.description,
      thumbnailUrl: item.assetUrl
    }))
})

function toggleReference(id: string, checked: boolean): void {
  const next = new Set(selectedReferenceIds.value)
  if (checked) next.add(id)
  else next.delete(id)
  selectedReferenceIds.value = [...next]
}

function referencesDirty(): boolean {
  const currentIds = [...(props.task?.referenceIds ?? [])].sort().join(',')
  const draftIds = [...selectedReferenceIds.value].sort().join(',')
  const currentReason = props.task?.referenceReason?.trim() ?? ''
  const draftReason = referenceReasonDraft.value.trim()
  return currentIds !== draftIds || currentReason !== draftReason
}

function saveReferences(): void {
  emit('saveReferences', {
    referenceIds: selectedReferenceIds.value,
    referenceReason: referenceReasonDraft.value.trim()
  })
}

const evidenceDetail = ref<TaskEvidenceDto | null>(null)
const evidenceDetailLoading = ref(false)
const evidenceDetailError = ref<string | null>(null)
const evidenceDetailExpanded = ref(false)

const inlineEvidenceLines = computed(() => props.task?.evidence?.evidence ?? [])

const needsEvidenceFetch = computed(() => {
  const task = props.task
  if (!task) return false
  if (task.evidenceArtifactId) return true
  const lineCount = task.evidence?.evidenceLineCount ?? inlineEvidenceLines.value.length
  return lineCount > 0 && inlineEvidenceLines.value.length === 0
})

const displayEvidenceSummary = computed(
  () => props.task?.evidenceSummary ?? props.task?.evidence?.summary ?? null
)

const displayEvidenceLines = computed(() => {
  if (inlineEvidenceLines.value.length) return inlineEvidenceLines.value
  return evidenceDetail.value?.evidence ?? []
})

watch(
  () => [props.task?.id, props.task?.evidenceArtifactId, props.threadId, props.jobId] as const,
  async () => {
    evidenceDetail.value = null
    evidenceDetailError.value = null
    evidenceDetailExpanded.value = false
    if (!needsEvidenceFetch.value || !props.threadId || !props.jobId || !props.task?.id) return
    evidenceDetailLoading.value = true
    try {
      const res = await fetchTaskEvidenceDetail(props.threadId, props.jobId, props.task.id)
      evidenceDetail.value = res.data.evidence
    } catch (error) {
      evidenceDetailError.value =
        error instanceof Error ? error.message : t('workspace.tasks.parameters.evidenceLoadFailed')
    } finally {
      evidenceDetailLoading.value = false
    }
  },
  { immediate: true }
)
</script>

<template>
  <div
    v-if="!task"
    class="rounded-md border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground"
  >
    {{ t('workspace.tasks.parameters.selectHint') }}
  </div>

  <div v-else class="space-y-4">
    <div>
      <p class="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {{ t('workspace.tasks.parameters.title') }}
      </p>
      <p class="mt-1 text-sm font-medium">{{ task.title }}</p>
    </div>

    <div class="grid gap-3 sm:grid-cols-2">
      <div class="rounded-md border border-border p-3">
        <p class="text-[11px] font-semibold uppercase text-muted-foreground">
          {{ t('workspace.tasks.parameters.kind') }}
        </p>
        <p class="mt-1 text-sm">{{ task.taskKind || '-' }}</p>
      </div>
      <div class="rounded-md border border-border p-3">
        <p class="text-[11px] font-semibold uppercase text-muted-foreground">
          {{ t('workspace.tasks.parameters.abilityCli') }}
        </p>
        <p class="mt-1 text-sm">
          {{ task ? resolveTaskCli(task, abilities) : '-' }}
        </p>
      </div>
    </div>

    <div
      v-if="task.errorMessage || task.evidence?.recovery"
      class="rounded-md border border-border p-3"
    >
      <p class="text-[11px] font-semibold uppercase text-muted-foreground">
        {{ t('workspace.tasks.parameters.executionOutcome') }}
      </p>
      <p v-if="task.error || task.errorMessage" class="mt-2 text-sm text-destructive">
        {{ formatTurnError(task.error ?? task.errorMessage, t) }}
      </p>
      <dl v-if="task.evidence?.recovery" class="mt-2 space-y-1 text-xs text-muted-foreground">
        <div class="flex gap-2">
          <dt class="shrink-0 font-medium">{{ t('workspace.tasks.parameters.recoveryKind') }}</dt>
          <dd>{{ task.evidence.recovery.kind }}</dd>
        </div>
        <div v-if="task.evidence.recovery.action" class="flex gap-2">
          <dt class="shrink-0 font-medium">{{ t('workspace.tasks.parameters.recoveryAction') }}</dt>
          <dd>{{ task.evidence.recovery.action }}</dd>
        </div>
        <div v-if="task.evidence.recovery.attempt" class="flex gap-2">
          <dt class="shrink-0 font-medium">
            {{ t('workspace.tasks.parameters.recoveryAttempt') }}
          </dt>
          <dd>{{ task.evidence.recovery.attempt }}/{{ task.evidence.recovery.maxAttempts }}</dd>
        </div>
      </dl>
      <p
        v-if="task.evidence?.summary"
        class="mt-2 whitespace-pre-wrap text-xs text-muted-foreground"
      >
        {{ task.evidence.summary }}
      </p>
      <p
        v-else-if="displayEvidenceSummary"
        class="mt-2 whitespace-pre-wrap text-xs text-muted-foreground"
      >
        {{ displayEvidenceSummary }}
      </p>
    </div>

    <div
      v-if="needsEvidenceFetch || displayEvidenceLines.length"
      class="rounded-md border border-border p-3"
    >
      <div class="flex items-center justify-between gap-2">
        <p class="text-[11px] font-semibold uppercase text-muted-foreground">
          {{ t('workspace.tasks.parameters.evidenceDetail') }}
        </p>
        <Button
          v-if="displayEvidenceLines.length > 3"
          type="button"
          variant="ghost"
          size="sm"
          class="h-7 px-2 text-xs"
          @click="evidenceDetailExpanded = !evidenceDetailExpanded"
        >
          {{
            evidenceDetailExpanded
              ? t('workspace.tasks.parameters.evidenceCollapse')
              : t('workspace.tasks.parameters.evidenceExpand')
          }}
        </Button>
      </div>
      <p v-if="evidenceDetailLoading" class="mt-2 text-xs text-muted-foreground">
        {{ t('workspace.tasks.parameters.evidenceLoading') }}
      </p>
      <p v-else-if="evidenceDetailError" class="mt-2 text-xs text-destructive">
        {{ evidenceDetailError }}
      </p>
      <ul
        v-else-if="displayEvidenceLines.length"
        class="mt-2 max-h-64 space-y-1 overflow-auto font-mono text-[11px] text-muted-foreground"
      >
        <li
          v-for="(line, index) in evidenceDetailExpanded
            ? displayEvidenceLines
            : displayEvidenceLines.slice(0, 3)"
          :key="index"
          class="whitespace-pre-wrap break-words"
        >
          {{ line }}
        </li>
      </ul>
      <p v-else class="mt-2 text-xs text-muted-foreground">
        {{ t('workspace.tasks.parameters.evidenceUnavailable') }}
      </p>
    </div>

    <EditablePlanField
      :label="t('workspace.tasks.parameters.description')"
      :model-value="task.description"
      :placeholder="t('workspace.tasks.parameters.noDescription')"
      :editable="fieldsEditable"
      :disabled="saving"
      :rows="3"
      @save="emit('saveField', { field: 'description', value: $event })"
    />

    <EditablePlanField
      :label="t('workspace.tasks.planNode.successCriteria')"
      :model-value="task.successCriteria"
      :editable="fieldsEditable"
      :disabled="saving"
      :rows="4"
      mono
      @save="emit('saveField', { field: 'successCriteria', value: $event })"
    />

    <EditablePlanField
      :label="t('workspace.tasks.parameters.context')"
      :model-value="task.contextMarkdown"
      :placeholder="t('workspace.tasks.parameters.contextPlaceholder')"
      :editable="fieldsEditable"
      :disabled="saving"
      :rows="8"
      mono
      @save="emit('saveField', { field: 'contextMarkdown', value: $event })"
    />

    <div
      v-if="referencesEditable || displayReferences.length"
      class="rounded-md border border-border p-3"
    >
      <p class="text-[11px] font-semibold uppercase text-muted-foreground">
        {{ t('workspace.tasks.parameters.references') }}
      </p>

      <template v-if="referencesEditable">
        <p class="mt-2 text-xs text-muted-foreground">
          {{ t('workspace.tasks.parameters.referencesEditHint') }}
        </p>
        <ul class="mt-3 space-y-2">
          <li
            v-for="reference in referenceManifest!.references"
            :key="reference.id"
            class="flex items-start gap-2 rounded-md border border-border/70 px-2 py-2"
          >
            <input
              :id="`task-ref-${task.id}-${reference.id}`"
              type="checkbox"
              class="mt-1"
              :checked="selectedReferenceIds.includes(reference.id)"
              :disabled="saving"
              @change="toggleReference(reference.id, ($event.target as HTMLInputElement).checked)"
            />
            <label
              :for="`task-ref-${task.id}-${reference.id}`"
              class="min-w-0 flex-1 cursor-pointer"
            >
              <span class="text-sm font-medium">{{ reference.name }}</span>
              <span v-if="reference.requiresDescription" class="ml-1 text-[10px] text-amber-700">
                {{ t('workspace.tasks.parameters.referenceRequired') }}
              </span>
              <p class="mt-0.5 text-xs text-muted-foreground">
                {{
                  reference.description || t('workspace.tasks.parameters.noReferenceDescription')
                }}
              </p>
            </label>
            <img
              v-if="reference.kind === 'image' && reference.assetUrl"
              :src="assetUrlWithAuth(reference.assetUrl)"
              :alt="reference.name"
              class="h-10 w-10 shrink-0 rounded border border-border object-cover"
            />
          </li>
        </ul>
        <label class="mt-3 block text-xs font-medium text-muted-foreground">
          {{ t('workspace.tasks.parameters.referenceReasonLabel') }}
        </label>
        <textarea
          v-model="referenceReasonDraft"
          class="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
          :placeholder="t('workspace.tasks.parameters.referenceReasonPlaceholder')"
          rows="2"
          :disabled="saving"
        />
        <div class="mt-3 flex justify-end">
          <Button
            type="button"
            size="sm"
            variant="outline"
            :disabled="saving || !referencesDirty()"
            @click="saveReferences"
          >
            {{ t('workspace.tasks.parameters.saveReferences') }}
          </Button>
        </div>
      </template>

      <template v-else>
        <p v-if="task.referenceReason?.trim()" class="mt-2 text-xs text-muted-foreground">
          {{ t('workspace.tasks.parameters.referenceReason', { reason: task.referenceReason }) }}
        </p>
        <ul class="mt-3 space-y-3">
          <li v-for="reference in displayReferences" :key="reference.id" class="flex gap-3">
            <a
              v-if="reference.thumbnailUrl && reference.kind === 'image'"
              :href="assetUrlWithAuth(reference.thumbnailUrl)"
              target="_blank"
              rel="noopener noreferrer"
              class="shrink-0"
            >
              <img
                :src="assetUrlWithAuth(reference.thumbnailUrl)"
                :alt="reference.name"
                class="h-14 w-14 rounded border border-border object-cover"
              />
            </a>
            <div class="min-w-0">
              <p class="text-sm font-medium">{{ reference.name }}</p>
              <p class="mt-1 text-xs text-muted-foreground">
                {{
                  reference.description || t('workspace.tasks.parameters.noReferenceDescription')
                }}
              </p>
            </div>
          </li>
        </ul>
      </template>
    </div>
  </div>
</template>
