<script setup lang="ts">
import Label from '@renderer/components/ui/Label.vue'
import { useI18n } from 'vue-i18n'
import type { JobProviderDescriptor, JobRoleSettings } from '@renderer/api/jobs'

const props = defineProps<{
  title: string
  description: string
  role: JobRoleSettings & { enabled?: boolean }
  defaults: JobRoleSettings & { enabled?: boolean }
  providers: JobProviderDescriptor[]
  validation: boolean
}>()
const { t } = useI18n()

const emit = defineEmits<{
  update: [value: JobRoleSettings & { enabled?: boolean }]
}>()

function patch(value: Partial<JobRoleSettings & { enabled?: boolean }>): void {
  emit('update', { ...props.role, ...value })
}

function inputValue(event: Event): string {
  return (event.target as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).value
}
</script>

<template>
  <section class="space-y-4 rounded-lg border border-border p-4">
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h3 class="font-medium">{{ title }}</h3>
        <p class="mt-1 text-xs text-muted-foreground">{{ description }}</p>
      </div>
      <label v-if="validation" class="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          :checked="role.enabled"
          @change="patch({ enabled: ($event.target as HTMLInputElement).checked })"
        />
        {{ t('jobs.settings.enabled') }}
      </label>
    </div>

    <div class="grid gap-4 sm:grid-cols-2">
      <div class="space-y-2">
        <Label>{{ t('jobs.settings.provider') }}</Label>
        <select
          :value="role.provider"
          class="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
          @change="patch({ provider: inputValue($event) as JobRoleSettings['provider'] })"
        >
          <option
            v-for="provider in providers.filter((item) =>
              validation ? item.supportsVerification : item.supportsTask
            )"
            :key="provider.code"
            :value="provider.code"
          >
            {{ provider.label }} · {{ provider.protocol }}
          </option>
        </select>
      </div>
      <div class="space-y-2">
        <Label>{{ t('jobs.settings.model') }}</Label>
        <input
          :value="role.model ?? ''"
          class="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
          @input="patch({ model: inputValue($event).trim() || null })"
        />
      </div>
    </div>

    <div class="space-y-2">
      <div class="flex items-center justify-between gap-2">
        <Label>{{ t('jobs.settings.prompt') }}</Label>
        <button
          type="button"
          class="text-xs text-primary underline"
          @click="patch({ prompt: defaults.prompt })"
        >
          {{ t('jobs.settings.resetDefault') }}
        </button>
      </div>
      <textarea
        :value="role.prompt"
        rows="3"
        class="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs"
        @input="patch({ prompt: inputValue($event) })"
      />
    </div>

    <div class="space-y-2">
      <div class="flex items-center justify-between gap-2">
        <Label>{{ t('jobs.settings.skills') }}</Label>
        <button
          type="button"
          class="text-xs text-primary underline"
          @click="patch({ skillsManual: defaults.skillsManual })"
        >
          {{ t('jobs.settings.resetDefault') }}
        </button>
      </div>
      <textarea
        :value="role.skillsManual"
        rows="9"
        class="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs leading-5"
        @input="patch({ skillsManual: inputValue($event) })"
      />
      <p class="text-xs text-muted-foreground">
        {{ t('jobs.settings.fixedProtocolHint') }}
      </p>
    </div>
  </section>
</template>
