<script setup lang="ts">
import { toRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { ConversationCore, ConversationMessage } from '@renderer/api/conversation'
import DraftStepForm from '@renderer/components/create/DraftStepForm.vue'
import { provideDraftPlanWorkspace } from '@renderer/composables/useDraftPlanWorkspace'
import type { TaskLaunchDraftPayload } from '@renderer/lib/draftForm'
import { isDraftListEntryLaunched } from '@shared/job-lifecycle'

const props = defineProps<{
  threadId: string
  messages: ConversationMessage[]
  cores: ConversationCore[]
  initialDraftId?: string | null
}>()

const emit = defineEmits<{
  draftUpdated: [draftId: string, draft: TaskLaunchDraftPayload]
  draftCreated: [messageId: string]
  planConfirmed: [payload: { jobId: string; draftMessageId: string; title: string }]
  workspaceReadyChange: [ready: boolean]
}>()

const { t } = useI18n()

const threadIdRef = toRef(props, 'threadId')
const initialDraftIdRef = toRef(props, 'initialDraftId')

const ws = provideDraftPlanWorkspace({
  threadId: threadIdRef,
  initialDraftId: initialDraftIdRef,
  t
})

let planConfirmedEmitted = false

watch(
  () => props.threadId,
  () => {
    planConfirmedEmitted = false
  }
)

watch(
  ws.workspaceReady,
  (ready) => {
    emit('workspaceReadyChange', ready)
  },
  { immediate: true }
)

function handleDraftUpdated(draftId: string, draft: TaskLaunchDraftPayload): void {
  emit('draftUpdated', draftId, draft)
  void ws.onDraftUpdated(draftId, draft)
}

watch(
  () => [ws.successMessage.value, ws.selectedPlan.value?.status, ws.selectedDraftId.value] as const,
  ([message, status, draftId]) => {
    const plan = ws.selectedPlan.value
    if (!message || !plan || !draftId || !status || planConfirmedEmitted) return
    if (!isDraftListEntryLaunched({ planStatus: status })) return
    planConfirmedEmitted = true
    emit('planConfirmed', { jobId: plan.id, draftMessageId: draftId, title: plan.title })
  }
)

defineExpose({
  onDraftCreated: ws.onDraftCreated,
  selectDraft: ws.selectDraft,
  loadWorkspace: ws.loadWorkspace,
  stopPlanStream: ws.stopPlanStream,
  workspaceReady: ws.workspaceReady,
  selectedDraftId: ws.selectedDraftId,
  drafts: ws.drafts
})
</script>

<template>
  <div class="flex min-h-0 min-w-0 flex-1 flex-col border-border bg-background xl:border-l">
    <DraftStepForm
      :thread-id="threadId"
      :messages="messages"
      :cores="cores"
      @draft-updated="handleDraftUpdated"
    />
  </div>
</template>
