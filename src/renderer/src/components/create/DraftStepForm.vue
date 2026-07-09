<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { ConversationCore, ConversationMessage } from '@renderer/api/conversation'
import { updateJobPlanNode } from '@renderer/api/jobs'
import type { Thread } from '@renderer/api/threads'
import TaskLaunchDraftCard from '@renderer/components/home/TaskLaunchDraftCard.vue'
import PlanReviewAccordion from '@renderer/components/tasks/PlanReviewAccordion.vue'
import TaskProgressTree from '@renderer/components/tasks/TaskProgressTree.vue'
import TaskProgressBar from '@renderer/components/tasks/TaskProgressBar.vue'
import Button from '@renderer/components/ui/Button.vue'
import ErrorAlert from '@renderer/components/ui/ErrorAlert.vue'
import Spinner from '@renderer/components/ui/Spinner.vue'
import { useDraftPlanWorkspace } from '@renderer/composables/useDraftPlanWorkspace'
import { getPlanProgressSnapshot } from '@renderer/lib/jobProgress'
import { formatTurnError } from '@renderer/i18n/formatTurnError'
import { cn } from '@renderer/lib/utils'

const props = defineProps<{
  threadId: string
  wizardPhase?: Thread['wizardPhase']
  messages: ConversationMessage[]
  cores: ConversationCore[]
}>()

const emit = defineEmits<{
  draftUpdated: [message: ConversationMessage]
}>()

const { t } = useI18n()
const ws = useDraftPlanWorkspace()
const savingTaskCli = ref(false)
const savingTaskId = ref<string | null>(null)
const savingPlanFields = ref(false)

const planProgressSnapshot = computed(() => getPlanProgressSnapshot(ws.selectedPlan.value, t))

const planStatus = computed(() => ws.selectedPlan.value?.status)

const isPlanning = computed(() => planStatus.value === 'planning')

const isPlanEditing = computed(() => planStatus.value === 'plan_editing')

const isExecuting = computed(() =>
  Boolean(
    ws.selectedPlan.value?.status &&
      ['pending', 'running', 'paused'].includes(ws.selectedPlan.value.status)
  )
)

const activeTaskId = computed(() => ws.selectedPlan.value?.taskProgress?.currentTaskId ?? null)

const isPlanFailed = computed(
  () => planStatus.value === 'failed' || planStatus.value === 'cancelled'
)

const planFailureMessage = computed(() => {
  const formatted = formatTurnError(ws.selectedPlan.value?.lastError, t)?.trim()
  return formatted || t('workspace.tasks.progress.planningFailed')
})

const planReviewMode = computed(() => isPlanning.value || isPlanEditing.value)

const showExecutionTree = computed(
  () => ws.showPlanEditor.value && (isPlanning.value || isPlanEditing.value)
)

const showPlanTreeDuringPlanning = computed(() => !isPlanning.value || ws.planTree.value.length > 0)

const executionTreeShellStyle = computed((): { minHeight?: string } | undefined => {
  if (isPlanning.value) {
    // Overlay content: py-6 + label row + h-36 progress box + summary (~18rem+).
    return ws.planTree.value.length === 0 ? undefined : { minHeight: '22rem' }
  }
  return { minHeight: '16rem' }
})

const planningOverlayClass = computed(() =>
  cn(
    'flex flex-col items-center gap-4 px-5 py-6',
    ws.planTree.value.length === 0
      ? ''
      : 'absolute inset-0 z-10 justify-start bg-background/80 pt-6 backdrop-blur-[2px]'
  )
)

watch(
  () => ws.selectedPlan.value?.id,
  () => {
    savingTaskId.value = null
  }
)

function planNodePatch(
  nodeRef: string,
  fields: Omit<Parameters<typeof updateJobPlanNode>[2], 'nodeRef' | 'expectedPlanRevision'>
): Parameters<typeof updateJobPlanNode>[2] {
  const plan = ws.selectedPlan.value
  const patch: Parameters<typeof updateJobPlanNode>[2] = { nodeRef, ...fields }
  if (plan && plan.planRevision != null) {
    patch.expectedPlanRevision = plan.planRevision
  }
  return patch
}

async function handlePlanNodeFieldSave(payload: {
  nodeRef: string
  field: 'description' | 'successCriteria' | 'contextMarkdown'
  value: string
}): Promise<void> {
  const plan = ws.selectedPlan.value
  if (!plan) return

  savingPlanFields.value = true
  ws.error.value = null
  try {
    const res = await updateJobPlanNode(
      props.threadId,
      plan.id,
      planNodePatch(payload.nodeRef, { [payload.field]: payload.value })
    )
    const idx = ws.plans.value.findIndex((item) => item.id === plan.id)
    if (idx >= 0) ws.plans.value[idx] = res.data.job
  } catch (err) {
    ws.error.value = err instanceof Error ? err.message : String(err)
  } finally {
    savingPlanFields.value = false
  }
}

async function handleTaskReferencesSave(payload: {
  nodeRef: string
  referenceIds: string[]
  referenceReason: string
}): Promise<void> {
  const plan = ws.selectedPlan.value
  if (!plan) return

  savingPlanFields.value = true
  ws.error.value = null
  try {
    const res = await updateJobPlanNode(
      props.threadId,
      plan.id,
      planNodePatch(payload.nodeRef, {
        referenceIds: payload.referenceIds,
        referenceReason: payload.referenceReason
      })
    )
    const idx = ws.plans.value.findIndex((item) => item.id === plan.id)
    if (idx >= 0) ws.plans.value[idx] = res.data.job
  } catch (err) {
    ws.error.value = err instanceof Error ? err.message : String(err)
  } finally {
    savingPlanFields.value = false
  }
}

async function handleTaskCliChange(payload: { taskId: string; coreCode: string }): Promise<void> {
  const plan = ws.selectedPlan.value
  if (!plan) return

  savingTaskCli.value = true
  savingTaskId.value = payload.taskId
  ws.error.value = null
  try {
    const res = await updateJobPlanNode(
      props.threadId,
      plan.id,
      planNodePatch(payload.taskId, { coreCode: payload.coreCode })
    )
    const idx = ws.plans.value.findIndex((item) => item.id === plan.id)
    if (idx >= 0) ws.plans.value[idx] = res.data.job
  } catch (err) {
    ws.error.value = err instanceof Error ? err.message : String(err)
  } finally {
    savingTaskCli.value = false
    savingTaskId.value = null
  }
}

const stepLabels = computed(() => [
  t('workspace.create.steps.collect'),
  t('workspace.create.steps.draft'),
  t('workspace.create.steps.executionTree')
])

function handleDraftUpdated(message: ConversationMessage): void {
  emit('draftUpdated', message)
  ws.onDraftUpdated(message)
}

function stepStatus(index: number): 'done' | 'current' | 'upcoming' {
  const current = ws.currentStep.value
  if (index < current) return 'done'
  if (index === current) return 'current'
  return 'upcoming'
}
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <div v-if="ws.error.value" class="shrink-0 px-4 pt-3">
      <ErrorAlert :message="ws.error.value" />
    </div>
    <div v-if="ws.successMessage.value" class="shrink-0 px-4 pt-2">
      <p
        class="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-800"
      >
        {{ ws.successMessage.value }}
      </p>
    </div>

    <div class="shrink-0 border-b border-border px-4 py-3">
      <ol class="flex gap-2">
        <li v-for="(label, index) in stepLabels" :key="index" class="flex flex-1 items-center">
          <button
            type="button"
            class="flex w-full items-center justify-center gap-2 rounded-md px-2 py-2 text-xs transition-colors"
            :class="
              cn(
                stepStatus(index) === 'current' && 'bg-primary/10 font-medium text-primary',
                stepStatus(index) === 'done' && 'text-muted-foreground',
                stepStatus(index) === 'upcoming' && 'text-muted-foreground/50'
              )
            "
            :disabled="index > ws.currentStep.value && !ws.selectedMessage.value"
            @click="ws.setStep(index)"
          >
            <span
              class="flex size-5 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold"
              :class="
                cn(
                  stepStatus(index) === 'current' && 'bg-primary text-primary-foreground',
                  stepStatus(index) === 'done' && 'bg-muted text-muted-foreground',
                  stepStatus(index) === 'upcoming' && 'border border-border text-muted-foreground'
                )
              "
            >
              {{ index + 1 }}
            </span>
            <span class="truncate">{{ label }}</span>
          </button>
        </li>
      </ol>
    </div>

    <div class="min-h-0 flex-1 overflow-y-auto px-4 py-4">
      <div v-if="ws.currentStep.value === 0" class="mx-auto max-w-lg py-8">
        <p class="text-sm leading-relaxed text-muted-foreground">
          {{ t('workspace.create.step0Hint') }}
        </p>
      </div>

      <div
        v-else-if="ws.currentStep.value === 1 && ws.selectedMessage.value"
        class="mx-auto max-w-3xl"
      >
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

      <div v-else-if="ws.currentStep.value === 2" class="mx-auto max-w-4xl space-y-4">
        <h2 class="text-sm font-semibold">{{ t('workspace.draftPanel.executionTree') }}</h2>

        <div
          v-if="showExecutionTree"
          class="rounded-md border border-border bg-card"
          :class="isPlanning && ws.planTree.value.length > 0 && 'relative overflow-hidden'"
          :style="executionTreeShellStyle"
        >
          <div
            v-if="showPlanTreeDuringPlanning"
            class="px-4 py-3"
            :class="isPlanning && 'pointer-events-none select-none opacity-50'"
          >
            <p v-if="isPlanEditing" class="mb-3 text-xs text-muted-foreground">
              {{ t('workspace.tasks.planNode.accordionHint') }}
            </p>
            <PlanReviewAccordion
              :milestones="ws.planTree.value"
              :abilities="ws.selectedPlan.value?.abilities"
              :reference-manifest="ws.selectedPlan.value?.referenceManifest"
              :review-mode="planReviewMode"
              :default-expand-all="isPlanEditing"
              :fields-editable="isPlanEditing"
              :task-cli-editable="isPlanEditing"
              :cores="cores"
              :saving-task-cli="savingTaskCli"
              :saving-task-id="savingTaskId"
              :saving-fields="savingPlanFields"
              @update-task-cli="handleTaskCliChange"
              @save-node-field="handlePlanNodeFieldSave"
              @save-task-references="handleTaskReferencesSave"
            />
          </div>

          <div v-if="isPlanning" :class="planningOverlayClass">
            <div class="flex w-full max-w-md shrink-0 flex-col items-center gap-3">
              <div class="flex items-center gap-2 text-muted-foreground">
                <Spinner class="size-5 shrink-0" />
                <p class="text-sm font-medium">
                  {{ t('workspace.tasks.progress.planLabel') }}
                </p>
              </div>
              <TaskProgressBar :snapshot="planProgressSnapshot" occupancy />
            </div>
            <p class="shrink-0 text-center text-sm text-muted-foreground">
              {{ planProgressSnapshot.summaryLabel }}
            </p>
          </div>

          <div v-if="isPlanEditing" class="border-t border-border px-4 py-3">
            <Button
              type="button"
              size="sm"
              :disabled="
                ws.confirmingPlan.value || Boolean(ws.selectedPlan.value?.referenceManifestStale)
              "
              @click="ws.handleConfirmPlan"
            >
              {{
                ws.confirmingPlan.value
                  ? t('workspace.draft.submitting')
                  : t('workspace.draftPanel.launchPlan')
              }}
            </Button>
          </div>
        </div>

        <div
          v-else-if="isExecuting"
          class="rounded-md border border-border bg-card p-4"
        >
          <TaskProgressTree
            :milestones="ws.planTree.value"
            :job-status="ws.selectedPlan.value?.status"
            :abilities="ws.selectedPlan.value?.abilities"
            :active-task-id="activeTaskId"
          />
        </div>

        <div
          v-else-if="isPlanFailed"
          class="space-y-4 rounded-md border border-destructive/30 bg-destructive/5 px-4 py-4"
        >
          <p class="text-sm font-medium text-destructive">
            {{ t('workspace.create.planningFailedTitle') }}
          </p>
          <p class="text-sm text-muted-foreground">{{ planFailureMessage }}</p>
          <Button
            type="button"
            size="sm"
            :disabled="ws.retryingPlan.value"
            @click="ws.handleRetryPlanning"
          >
            {{
              ws.retryingPlan.value
                ? t('workspace.create.retryingPlanning')
                : t('workspace.create.retryPlanning')
            }}
          </Button>
        </div>

        <p
          v-else-if="!ws.selectedPlan.value || ws.selectedPlan.value.status === 'pending'"
          class="text-sm text-muted-foreground"
        >
          {{ t('workspace.draftPanel.planNotReady') }}
        </p>
      </div>

      <div
        v-else
        class="flex flex-1 items-center justify-center py-12 text-sm text-muted-foreground"
      >
        {{ t('workspace.draftPanel.centerEmpty') }}
      </div>
    </div>
  </div>
</template>
