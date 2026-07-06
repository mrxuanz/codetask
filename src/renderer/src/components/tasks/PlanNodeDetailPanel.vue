<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import type { ConversationCore } from '@renderer/api/conversation'
import PlanNodeDetailContent from '@renderer/components/tasks/PlanNodeDetailContent.vue'
import type { PlanTreeSelection } from '@renderer/lib/jobProgress'

defineProps<{
  selection: PlanTreeSelection | null
  abilities?: Array<{ abilityCode: string; recommendedCoreCode?: string }>
  reviewMode?: boolean
  taskCliEditable?: boolean
  cores?: ConversationCore[]
  savingTaskCli?: boolean
}>()

defineEmits<{
  updateTaskCli: [coreCode: string]
}>()

const { t } = useI18n()
</script>

<template>
  <div
    v-if="!selection"
    class="rounded-md border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground"
  >
    {{ t('workspace.tasks.planNode.selectHint') }}
  </div>

  <PlanNodeDetailContent
    v-else
    :selection="selection"
    :abilities="abilities"
    :review-mode="reviewMode"
    :task-cli-editable="taskCliEditable"
    :cores="cores"
    :saving-task-cli="savingTaskCli"
    @update-task-cli="$emit('updateTaskCli', $event)"
  />
</template>
