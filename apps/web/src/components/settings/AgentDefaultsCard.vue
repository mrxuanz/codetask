<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { AgentDefaultsSettings, AgentCoreOption } from '@renderer/api/settings'
import Label from '@renderer/components/ui/Label.vue'

defineProps<{
  draft: AgentDefaultsSettings
  cores: AgentCoreOption[]
  disabled?: boolean
}>()

const emit = defineEmits<{
  update: [patch: Partial<AgentDefaultsSettings>]
}>()

const { t } = useI18n()

const fields = computed(() => [
  { key: 'plannerProvider' as const, label: t('workspace.settings.agents.planner') },
  {
    key: 'sliceVerifierProvider' as const,
    label: t('workspace.settings.agents.sliceVerifier')
  },
  {
    key: 'milestoneVerifierProvider' as const,
    label: t('workspace.settings.agents.milestoneVerifier')
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
          :disabled="
            !core.available || (field.key === 'plannerProvider' && core.readOnlyCapable === false)
          "
        >
          {{ core.label
          }}{{ core.available ? '' : ` (${t('workspace.settings.agents.unavailable')})` }}
        </option>
      </select>
    </div>
  </div>
</template>
