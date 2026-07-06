<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { ConversationCore, ConversationMessage } from '@renderer/api/conversation'
import TaskLaunchDraftCard from '@renderer/components/home/TaskLaunchDraftCard.vue'
import TaskProgressBar from '@renderer/components/tasks/TaskProgressBar.vue'
import TaskProgressTree from '@renderer/components/tasks/TaskProgressTree.vue'
import Button from '@renderer/components/ui/Button.vue'
import ErrorAlert from '@renderer/components/ui/ErrorAlert.vue'
import { useDraftPlanWorkspace } from '@renderer/composables/useDraftPlanWorkspace'
import { getPlanProgressSnapshot } from '@renderer/lib/jobProgress'

defineProps<{
  threadId: string
  messages: ConversationMessage[]
  cores: ConversationCore[]
}>()

const emit = defineEmits<{
  draftUpdated: [message: ConversationMessage]
}>()

const { t } = useI18n()
const ws = useDraftPlanWorkspace()

const planProgressSnapshot = computed(() => getPlanProgressSnapshot(ws.selectedPlan.value, t))

function handleDraftUpdated(message: ConversationMessage): void {
  emit('draftUpdated', message)
  ws.onDraftUpdated(message)
}
</script>

<template>
  <div class="flex h-full min-h-0 flex-col overflow-hidden pt-8">
    <div v-if="ws.error.value" class="shrink-0 px-4 pt-2">
      <ErrorAlert :message="ws.error.value" />
    </div>

    <div
      v-if="!ws.selectedMessage.value"
      class="flex flex-1 items-center justify-center px-6 text-sm text-muted-foreground"
    >
      {{ t('workspace.draftPanel.centerEmpty') }}
    </div>

    <div v-else class="min-h-0 flex-1 overflow-y-auto px-4 py-4">
      <div v-if="ws.centerView.value === 'draft'" class="mx-auto max-w-3xl">
        <h2 class="mb-3 text-sm font-semibold">{{ t('workspace.draftPanel.editDraft') }}</h2>
        <TaskLaunchDraftCard
          :message="ws.selectedMessage.value"
          :thread-id="threadId"
          :thread-messages="messages"
          :cores="cores"
          embedded
          @updated="handleDraftUpdated"
          @plan-started="ws.handlePlanStarted"
        />
      </div>

      <div v-else-if="ws.centerView.value === 'plan'" class="mx-auto max-w-4xl space-y-4">
        <div class="flex items-center justify-between gap-2">
          <h2 class="text-sm font-semibold">{{ t('workspace.draftPanel.executionTree') }}</h2>
          <span v-if="ws.selectedPlan.value" class="text-xs text-muted-foreground">
            {{ ws.selectedPlan.value.status }}
          </span>
        </div>

        <div
          v-if="ws.selectedPlan.value?.status === 'planning'"
          class="rounded-md border border-border bg-card p-4"
        >
          <p class="mb-3 text-[11px] font-semibold uppercase text-muted-foreground">
            {{ t('workspace.tasks.progress.planLabel') }}
          </p>
          <TaskProgressBar :snapshot="planProgressSnapshot" />
        </div>

        <TaskProgressTree
          v-if="
            ws.planTree.value.length > 0 &&
            (ws.selectedPlan.value?.status === 'planning' || ws.showPlanEditor.value)
          "
          :milestones="ws.planTree.value"
          :job-status="ws.selectedPlan.value?.status"
          :abilities="ws.selectedPlan.value?.abilities"
        />

        <template v-if="ws.selectedPlan.value?.status === 'plan_editing'">
          <Button
            type="button"
            size="sm"
            :disabled="ws.confirmingPlan.value"
            @click="ws.handleConfirmPlan"
          >
            {{
              ws.confirmingPlan.value
                ? t('workspace.draft.submitting')
                : t('workspace.draftPanel.launchPlan')
            }}
          </Button>
        </template>

        <p
          v-else-if="!ws.selectedPlan.value || ws.selectedPlan.value.status === 'pending'"
          class="text-sm text-muted-foreground"
        >
          {{ t('workspace.draftPanel.planNotReady') }}
        </p>
      </div>
    </div>
  </div>
</template>
