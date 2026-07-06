<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { ControlPlanePolicies, AgentCoreOption } from '@renderer/api/settings'
import Label from '@renderer/components/ui/Label.vue'

defineProps<{
  draft: ControlPlanePolicies
  cores: AgentCoreOption[]
  disabled?: boolean
}>()

const emit = defineEmits<{
  update: [patch: Partial<ControlPlanePolicies>]
}>()

const { t } = useI18n()

const fields = computed(() => [
  { key: 'plannerCoreCode' as const, label: t('workspace.settings.controlPlane.planner') },
  {
    key: 'sliceVerifierCoreCode' as const,
    label: t('workspace.settings.controlPlane.sliceVerifier')
  },
  {
    key: 'milestoneVerifierCoreCode' as const,
    label: t('workspace.settings.controlPlane.milestoneVerifier')
  }
])
</script>

<template>
  <div class="grid gap-4 sm:grid-cols-2">
    <div v-for="field in fields" :key="field.key" class="space-y-2">
      <Label :for="field.key">{{ field.label }}</Label>
      <select
        :id="field.key"
        class="h-10 w-full rounded-md border border-border bg-background px-3 text-sm"
        :disabled="disabled"
        :value="draft[field.key]"
        @change="emit('update', { [field.key]: ($event.target as HTMLSelectElement).value })"
      >
        <option
          v-for="core in cores"
          :key="core.code"
          :value="core.code"
          :disabled="!core.available"
        >
          {{ core.label
          }}{{ core.available ? '' : ` (${t('workspace.settings.controlPlane.unavailable')})` }}
        </option>
      </select>
    </div>
  </div>
</template>
