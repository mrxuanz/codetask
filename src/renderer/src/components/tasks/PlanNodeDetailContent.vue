<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { ConversationCore } from '@renderer/api/conversation'
import type { JobReferenceManifestDto } from '@shared/contracts/jobs'
import EditablePlanField from '@renderer/components/tasks/EditablePlanField.vue'
import TaskParameterPanel from '@renderer/components/tasks/TaskParameterPanel.vue'
import { resolveTaskCli, type PlanTreeSelection } from '@renderer/lib/jobProgress'

const props = defineProps<{
  selection: PlanTreeSelection
  abilities?: Array<{ abilityCode: string; recommendedCoreCode?: string }>
  referenceManifest?: JobReferenceManifestDto | null
  reviewMode?: boolean
  fieldsEditable?: boolean
  taskCliEditable?: boolean
  cores?: ConversationCore[]
  savingTaskCli?: boolean
  savingFields?: boolean
}>()

const emit = defineEmits<{
  updateTaskCli: [coreCode: string]
  saveNodeField: [
    payload: {
      nodeRef: string
      field: 'description' | 'successCriteria' | 'contextMarkdown'
      value: string
    }
  ]
  saveTaskReferences: [
    payload: { nodeRef: string; referenceIds: string[]; referenceReason: string }
  ]
}>()

const { t } = useI18n()

const taskNode = computed(() => (props.selection.kind === 'task' ? props.selection.node : null))

const selectedCoreCode = computed(() => {
  const task = taskNode.value
  if (!task) return ''
  if (task.coreCode?.trim()) return task.coreCode.trim()
  const match = props.abilities?.find((item) => item.abilityCode === task.abilityCode)
  return match?.recommendedCoreCode?.trim() ?? ''
})

function handleCliChange(event: Event): void {
  const value = (event.target as HTMLSelectElement).value.trim()
  if (!value || value === selectedCoreCode.value) return
  emit('updateTaskCli', value)
}

function saveNodeField(field: 'description' | 'successCriteria', value: string): void {
  emit('saveNodeField', { nodeRef: props.selection.node.id, field, value })
}

function saveTaskField(payload: {
  field: 'description' | 'successCriteria' | 'contextMarkdown'
  value: string
}): void {
  if (!taskNode.value) return
  emit('saveNodeField', { nodeRef: taskNode.value.id, ...payload })
}
</script>

<template>
  <div v-if="selection.kind === 'task'" class="space-y-4">
    <TaskParameterPanel
      :task="taskNode"
      :abilities="abilities"
      :reference-manifest="referenceManifest"
      :fields-editable="fieldsEditable"
      :saving="savingFields"
      @save-field="saveTaskField"
      @save-references="
        taskNode &&
        emit('saveTaskReferences', {
          nodeRef: taskNode.id,
          referenceIds: $event.referenceIds,
          referenceReason: $event.referenceReason
        })
      "
    />
    <div v-if="taskCliEditable && taskNode" class="rounded-md border border-border p-3">
      <p class="text-[11px] font-semibold uppercase text-muted-foreground">
        {{ t('workspace.tasks.parameters.abilityCli') }}
      </p>
      <p class="mt-1 text-xs text-muted-foreground">
        {{ t('workspace.tasks.planNode.taskCliHint') }}
        <span v-if="taskNode.abilityCode" class="text-foreground">
          · {{ resolveTaskCli(taskNode, abilities) }}
        </span>
      </p>
      <select
        class="mt-2 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
        :disabled="savingTaskCli"
        :value="selectedCoreCode"
        @change="handleCliChange"
      >
        <option value="">{{ t('workspace.draft.selectCli') }}</option>
        <option v-for="core in cores ?? []" :key="core.code" :value="core.code">
          {{ core.label }}{{ core.available ? '' : ` (${t('workspace.draft.cliUnavailable')})` }}
        </option>
      </select>
    </div>
  </div>

  <div v-else class="space-y-3">
    <EditablePlanField
      :label="t('workspace.tasks.parameters.description')"
      :model-value="selection.node.description"
      :placeholder="t('workspace.tasks.parameters.noDescription')"
      :editable="fieldsEditable"
      :disabled="savingFields"
      :rows="3"
      @save="saveNodeField('description', $event)"
    />

    <EditablePlanField
      :label="t('workspace.tasks.planNode.successCriteria')"
      :model-value="selection.node.successCriteria"
      :editable="fieldsEditable"
      :disabled="savingFields"
      :rows="4"
      mono
      @save="saveNodeField('successCriteria', $event)"
    />

    <div
      v-if="
        !reviewMode &&
        (selection.node.verificationStatus ||
          (selection.kind === 'slice' && selection.node.runtimeStatus))
      "
      class="grid gap-3 sm:grid-cols-2"
    >
      <div v-if="selection.node.verificationStatus" class="rounded-md border border-border p-3">
        <p class="text-[11px] font-semibold uppercase text-muted-foreground">
          {{ t('workspace.tasks.planNode.verificationStatus') }}
        </p>
        <p class="mt-1 text-sm">{{ selection.node.verificationStatus }}</p>
      </div>
      <div
        v-if="selection.kind === 'slice' && selection.node.runtimeStatus"
        class="rounded-md border border-border p-3"
      >
        <p class="text-[11px] font-semibold uppercase text-muted-foreground">
          {{ t('workspace.tasks.planNode.runtimeStatus') }}
        </p>
        <p class="mt-1 text-sm">{{ selection.node.runtimeStatus }}</p>
      </div>
    </div>
  </div>
</template>
