<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { useDraftPlanWorkspace } from '@renderer/composables/useDraftPlanWorkspace'
import { cn } from '@renderer/lib/utils'

const { t } = useI18n()
const ws = useDraftPlanWorkspace()

function draftStatusLabel(status: string): string {
  if (status === 'confirmed') return t('workspace.draftPanel.statusConfirmed')
  if (status === 'archived') return t('workspace.draftPanel.statusArchived')
  return t('workspace.draftPanel.statusEditing')
}

function stepLabel(draft: (typeof ws.drafts.value)[number]): string {
  const step = ws.resolveDraftStepForDraft(draft)
  return t('workspace.create.stepProgress', {
    current: step + 1,
    total: ws.stepCount
  })
}
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <div class="border-b border-border px-3 py-2">
      <h2 class="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {{ t('workspace.draftPanel.title') }}
      </h2>
    </div>

    <div class="min-h-0 flex-1 overflow-y-auto px-2 py-2">
      <div
        v-if="ws.loading.value && ws.drafts.value.length === 0"
        class="px-2 py-4 text-sm text-muted-foreground"
      >
        {{ t('workspace.loadingMessages') }}
      </div>

      <ul v-else class="space-y-1">
        <li
          v-for="draft in ws.drafts.value"
          :key="draft.messageId"
          class="rounded-md border border-transparent"
        >
          <button
            type="button"
            class="flex w-full flex-col rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted"
            :class="cn(ws.isDraftSelected(draft.messageId) && 'bg-muted ring-1 ring-border')"
            @click="ws.selectDraft(draft.messageId)"
          >
            <span class="truncate font-medium">{{ draft.title }}</span>
            <span class="text-xs text-muted-foreground">{{ draftStatusLabel(draft.status) }}</span>
            <span class="text-[10px] text-muted-foreground/80">{{ stepLabel(draft) }}</span>
          </button>
        </li>
        <li v-if="ws.drafts.value.length === 0" class="px-2 py-4 text-sm text-muted-foreground">
          {{ t('workspace.draftPanel.empty') }}
        </li>
      </ul>
    </div>
  </div>
</template>
