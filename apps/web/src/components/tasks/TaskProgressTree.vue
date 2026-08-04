<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  nodeIcon,
  formatMilestoneTitle,
  formatSliceTitle,
  resolveTaskCli,
  statusBadgeLabel,
  taskVisualStatus,
  type UnifiedMilestoneNode,
  type UnifiedSliceNode,
  type UnifiedTaskNode
} from '@renderer/lib/jobProgress'
import { cn } from '@renderer/lib/utils'

const props = defineProps<{
  milestones: UnifiedMilestoneNode[]
  jobStatus?: string
  abilities?: Array<{ abilityCode: string; recommendedCoreCode?: string }>
  selectedMilestoneId?: string | null
  selectedSliceId?: string | null
  selectedTaskId?: string | null
  activeTaskId?: string | null
  hideStatus?: boolean
}>()

const emit = defineEmits<{
  selectMilestone: [milestone: UnifiedMilestoneNode]
  selectSlice: [slice: UnifiedSliceNode]
  selectTask: [task: UnifiedTaskNode]
}>()

function selectableRowClass(selected: boolean): string {
  return cn(
    'flex w-full flex-wrap items-center gap-2 rounded-md border border-border/60 bg-background px-2.5 py-2 text-left transition-colors hover:border-border',
    selected ? 'ring-1 ring-primary/40' : ''
  )
}

const { t } = useI18n()

const hasData = computed(() => props.milestones.length > 0)
const isPlanning = computed(() => props.jobStatus === 'planning')
const phase = computed<'plan' | 'execution'>(() => (isPlanning.value ? 'plan' : 'execution'))

function nodeTone(status: string): string {
  switch (status) {
    case 'completed':
    case 'planned':
      return 'text-emerald-600'
    case 'in_progress':
      return 'text-sky-600'
    case 'paused':
      return 'text-zinc-600'
    case 'failed':
      return 'text-red-600'
    default:
      return 'text-muted-foreground'
  }
}

function badgeClass(status: string): string {
  switch (status) {
    case 'completed':
    case 'planned':
    case 'progress-ok':
    case 'passed':
      return 'bg-emerald-50 text-emerald-700'
    case 'in_progress':
    case 'verifying':
    case 'ready-for-verification':
      return 'bg-sky-50 text-sky-700'
    case 'paused':
      return 'bg-zinc-100 text-zinc-700'
    case 'failed':
    case 'verification-blocked':
    case 'blocked':
    case 'inconclusive':
      return 'bg-red-50 text-red-700'
    default:
      return 'bg-muted text-muted-foreground'
  }
}

function milestoneBadgeLabel(milestone: UnifiedMilestoneNode): string {
  if (
    milestone.verificationStatus === 'verifying' ||
    milestone.verificationStatus === 'ready-for-verification'
  ) {
    return milestone.verificationStatus
  }
  const verifyingSlice = milestone.slices.find(
    (slice) =>
      slice.runtimeStatus === 'verifying' ||
      slice.runtimeStatus === 'ready-for-verification' ||
      slice.verificationStatus === 'verifying' ||
      slice.verificationStatus === 'ready-for-verification'
  )
  if (verifyingSlice) {
    return verifyingSlice.runtimeStatus ?? verifyingSlice.verificationStatus ?? ''
  }
  return statusBadgeLabel(milestone.status, t, 'execution')
}

function milestoneBadgeTone(milestone: UnifiedMilestoneNode): string {
  const label = milestoneBadgeLabel(milestone)
  if (
    label === 'verifying' ||
    label === 'ready-for-verification' ||
    milestone.status === 'in_progress'
  ) {
    return 'in_progress'
  }
  if (milestone.status === 'paused' || label === 'paused') {
    return 'paused'
  }
  if (label === 'progress-ok' || label === 'passed' || milestone.status === 'completed') {
    return 'completed'
  }
  if (
    label === 'verification-blocked' ||
    label === 'blocked' ||
    label === 'inconclusive' ||
    milestone.status === 'failed'
  ) {
    return 'failed'
  }
  return milestone.status
}
</script>

<template>
  <p
    v-if="!hasData"
    class="rounded-md border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground"
  >
    {{ t('workspace.tasks.tree.empty') }}
  </p>

  <div v-else class="space-y-4">
    <div
      v-for="(milestone, msIdx) in milestones"
      :key="milestone.id"
      class="rounded-md border border-border bg-card"
    >
      <button
        type="button"
        class="flex w-full flex-wrap items-center gap-2 border-b border-border px-3 py-2.5 text-left transition-colors hover:bg-muted/30"
        :class="
          selectedMilestoneId === milestone.id
            ? 'bg-primary/5 ring-1 ring-inset ring-primary/30'
            : ''
        "
        @click="emit('selectMilestone', milestone)"
      >
        <span class="text-xs font-semibold text-muted-foreground">M{{ msIdx + 1 }}</span>
        <span class="min-w-0 flex-1 truncate text-sm font-medium">{{
          formatMilestoneTitle(milestone.title, msIdx + 1, t)
        }}</span>
        <span
          v-if="!hideStatus && !isPlanning && milestoneBadgeLabel(milestone)"
          class="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium"
          :class="badgeClass(milestoneBadgeTone(milestone))"
        >
          {{ milestoneBadgeLabel(milestone) }}
        </span>
      </button>
      <p
        v-if="milestone.description || milestone.successCriteria"
        class="border-b border-border px-3 py-2 text-xs text-muted-foreground"
      >
        {{ milestone.description || milestone.successCriteria }}
      </p>

      <div class="space-y-3 p-3">
        <div
          v-for="(slice, slIdx) in milestone.slices"
          :key="slice.id"
          class="rounded-md border border-border/70 bg-muted/20"
        >
          <button
            type="button"
            class="flex w-full flex-wrap items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-muted/30"
            :class="
              selectedSliceId === slice.id ? 'bg-primary/5 ring-1 ring-inset ring-primary/30' : ''
            "
            @click="emit('selectSlice', slice)"
          >
            <span class="text-[11px] font-medium text-muted-foreground">
              S{{ msIdx + 1 }}.{{ slIdx + 1 }}
            </span>
            <span class="min-w-0 flex-1 truncate text-sm">{{
              formatSliceTitle(slice.title, slIdx + 1, t)
            }}</span>
            <span
              v-if="!hideStatus && !isPlanning && (slice.runtimeStatus || slice.status)"
              class="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium"
              :class="
                badgeClass(
                  slice.runtimeStatus === 'progress-ok'
                    ? 'completed'
                    : slice.runtimeStatus === 'verifying' ||
                        slice.runtimeStatus === 'ready-for-verification'
                      ? 'in_progress'
                      : slice.status
                )
              "
            >
              {{
                statusBadgeLabel(
                  slice.runtimeStatus === 'progress-ok'
                    ? 'completed'
                    : slice.runtimeStatus && slice.runtimeStatus !== 'running'
                      ? slice.runtimeStatus
                      : slice.status,
                  t,
                  'execution'
                )
              }}
            </span>
          </button>

          <div class="space-y-2 border-t border-border/60 px-3 py-2">
            <button
              v-for="task in slice.tasks"
              :key="task.id"
              type="button"
              :class="selectableRowClass(selectedTaskId === task.id)"
              @click="emit('selectTask', task)"
            >
              <span
                v-if="!hideStatus"
                :title="t('workspace.tasks.tree.statusIconHint')"
                :class="
                  cn(
                    'w-4 shrink-0 text-center text-xs',
                    nodeTone(taskVisualStatus(task, jobStatus ?? ''))
                  )
                "
              >
                {{ nodeIcon(taskVisualStatus(task, jobStatus ?? ''), activeTaskId === task.id) }}
              </span>
              <span class="min-w-0 flex-1 truncate text-sm" :title="task.title">
                {{ task.title }}
              </span>
              <span
                v-if="task.assignedReferences?.length"
                class="shrink-0 rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700"
                :title="task.assignedReferences.map((item) => item.name).join(', ')"
              >
                {{
                  t('workspace.tasks.tree.referenceCount', {
                    count: task.assignedReferences.length
                  })
                }}
              </span>
              <span
                v-if="task.abilityCode"
                class="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
              >
                {{ t('workspace.tasks.tree.cli', { name: resolveTaskCli(task, abilities) }) }}
              </span>
              <span
                v-if="!hideStatus"
                class="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium"
                :class="badgeClass(taskVisualStatus(task, jobStatus ?? ''))"
              >
                {{
                  statusBadgeLabel(
                    isPlanning ? task.planStatus : taskVisualStatus(task, jobStatus ?? ''),
                    t,
                    phase
                  )
                }}
              </span>
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
