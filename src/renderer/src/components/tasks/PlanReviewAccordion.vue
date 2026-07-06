<script setup lang="ts">
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { ConversationCore } from '@renderer/api/conversation'
import type { JobReferenceManifestDto } from '@shared/contracts/jobs'
import PlanNodeDetailContent from '@renderer/components/tasks/PlanNodeDetailContent.vue'
import { resolveTaskCli, type UnifiedMilestoneNode } from '@renderer/lib/jobProgress'
import { cn } from '@renderer/lib/utils'

const props = defineProps<{
  milestones: UnifiedMilestoneNode[]
  abilities?: Array<{ abilityCode: string; recommendedCoreCode?: string }>
  referenceManifest?: JobReferenceManifestDto | null
  reviewMode?: boolean
  defaultExpandAll?: boolean
  taskCliEditable?: boolean
  fieldsEditable?: boolean
  cores?: ConversationCore[]
  savingTaskCli?: boolean
  savingTaskId?: string | null
  savingFields?: boolean
}>()

const emit = defineEmits<{
  updateTaskCli: [payload: { taskId: string; coreCode: string }]
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
const expanded = ref<Record<string, boolean>>({})

function applyDefaultExpansion(): void {
  if (!props.defaultExpandAll) {
    expanded.value = {}
    return
  }
  const next: Record<string, boolean> = {}
  for (const milestone of props.milestones) {
    next[keyFor('milestone', milestone.id)] = true
    for (const slice of milestone.slices) {
      next[keyFor('slice', slice.id)] = true
    }
  }
  expanded.value = next
}

watch(
  () => [props.milestones.map((m) => m.id).join(','), props.defaultExpandAll] as const,
  () => {
    applyDefaultExpansion()
  },
  { immediate: true }
)

function keyFor(kind: 'milestone' | 'slice' | 'task', id: string): string {
  return `${kind}:${id}`
}

function isOpen(kind: 'milestone' | 'slice' | 'task', id: string): boolean {
  return Boolean(expanded.value[keyFor(kind, id)])
}

function toggle(kind: 'milestone' | 'slice' | 'task', id: string): void {
  const key = keyFor(kind, id)
  expanded.value = { ...expanded.value, [key]: !expanded.value[key] }
}

function headerClass(open: boolean): string {
  return cn(
    'flex w-full items-center gap-2 px-3 py-2.5 text-left transition-colors hover:bg-muted/40',
    open && 'bg-muted/20'
  )
}

function chevronClass(open: boolean): string {
  return cn('size-3.5 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')
}
</script>

<template>
  <p
    v-if="milestones.length === 0"
    class="rounded-md border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground"
  >
    {{ t('workspace.tasks.tree.empty') }}
  </p>

  <div v-else class="overflow-hidden rounded-md border border-border bg-card">
    <div
      v-for="(milestone, msIdx) in milestones"
      :key="milestone.id"
      class="border-b border-border last:border-b-0"
    >
      <button
        type="button"
        :class="headerClass(isOpen('milestone', milestone.id))"
        @click="toggle('milestone', milestone.id)"
      >
        <svg
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          :class="chevronClass(isOpen('milestone', milestone.id))"
          aria-hidden="true"
        >
          <path d="M6 4l4 4-4 4" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        <span class="text-xs font-semibold text-muted-foreground">M{{ msIdx + 1 }}</span>
        <span class="min-w-0 flex-1 truncate text-sm font-medium">{{ milestone.title }}</span>
      </button>

      <div
        v-if="isOpen('milestone', milestone.id)"
        class="border-t border-border bg-muted/10 px-3 py-3"
      >
        <PlanNodeDetailContent
          :selection="{ kind: 'milestone', node: milestone }"
          :abilities="abilities"
          :review-mode="reviewMode"
          :fields-editable="fieldsEditable"
          :saving-fields="savingFields"
          @save-node-field="emit('saveNodeField', $event)"
        />

        <div class="mt-3 space-y-2">
          <div
            v-for="(slice, slIdx) in milestone.slices"
            :key="slice.id"
            class="overflow-hidden rounded-md border border-border/70 bg-background"
          >
            <button
              type="button"
              :class="headerClass(isOpen('slice', slice.id))"
              @click="toggle('slice', slice.id)"
            >
              <svg
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                stroke-width="1.5"
                :class="chevronClass(isOpen('slice', slice.id))"
                aria-hidden="true"
              >
                <path d="M6 4l4 4-4 4" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
              <span class="text-[11px] font-medium text-muted-foreground">
                S{{ msIdx + 1 }}.{{ slIdx + 1 }}
              </span>
              <span class="min-w-0 flex-1 truncate text-sm">{{ slice.title }}</span>
            </button>

            <div v-if="isOpen('slice', slice.id)" class="border-t border-border/60 px-3 py-3">
              <PlanNodeDetailContent
                :selection="{ kind: 'slice', node: slice }"
                :abilities="abilities"
                :review-mode="reviewMode"
                :fields-editable="fieldsEditable"
                :saving-fields="savingFields"
                @save-node-field="emit('saveNodeField', $event)"
              />

              <div class="mt-3 space-y-2">
                <div
                  v-for="task in slice.tasks"
                  :key="task.id"
                  class="overflow-hidden rounded-md border border-border/60 bg-muted/10"
                >
                  <button
                    type="button"
                    :class="headerClass(isOpen('task', task.id))"
                    @click="toggle('task', task.id)"
                  >
                    <svg
                      viewBox="0 0 16 16"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="1.5"
                      :class="chevronClass(isOpen('task', task.id))"
                      aria-hidden="true"
                    >
                      <path d="M6 4l4 4-4 4" stroke-linecap="round" stroke-linejoin="round" />
                    </svg>
                    <span class="min-w-0 flex-1 truncate text-sm" :title="task.title">
                      {{ task.title }}
                    </span>
                    <span
                      v-if="task.abilityCode"
                      class="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
                    >
                      {{
                        t('workspace.tasks.tree.cli', {
                          name: resolveTaskCli(task, abilities)
                        })
                      }}
                    </span>
                  </button>

                  <div v-if="isOpen('task', task.id)" class="border-t border-border/60 px-3 py-3">
                    <PlanNodeDetailContent
                      :selection="{ kind: 'task', node: task }"
                      :abilities="abilities"
                      :reference-manifest="referenceManifest"
                      :review-mode="reviewMode"
                      :fields-editable="fieldsEditable"
                      :task-cli-editable="taskCliEditable"
                      :cores="cores"
                      :saving-task-cli="savingTaskCli && savingTaskId === task.id"
                      :saving-fields="savingFields"
                      @update-task-cli="
                        emit('updateTaskCli', { taskId: task.id, coreCode: $event })
                      "
                      @save-node-field="emit('saveNodeField', $event)"
                      @save-task-references="emit('saveTaskReferences', $event)"
                    />
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
