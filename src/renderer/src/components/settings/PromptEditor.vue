<script setup lang="ts">
import { useI18n } from 'vue-i18n'

import type { PromptBodySetting } from '@renderer/api/settings'

import Label from '@renderer/components/ui/Label.vue'

import { cn } from '@renderer/lib/utils'

const props = defineProps<{
  title: string

  entry: PromptBodySetting

  defaultBody: string

  disabled?: boolean
}>()

const emit = defineEmits<{
  'update:entry': [value: PromptBodySetting]
}>()

const { t } = useI18n()

function toggleDefault(checked: boolean): void {
  emit('update:entry', {
    ...props.entry,

    useDefault: checked,

    body: checked ? props.defaultBody : props.entry.body || props.defaultBody
  })
}

function updateBody(value: string): void {
  emit('update:entry', { ...props.entry, body: value, useDefault: false })
}

function resetDefault(): void {
  emit('update:entry', { body: props.defaultBody, useDefault: true })
}
</script>

<template>
  <div class="rounded-lg border border-border p-4">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <h3 class="text-sm font-semibold">{{ title }}</h3>

      <label class="flex items-center gap-2 text-xs text-muted-foreground">
        <input
          type="checkbox"
          :checked="entry.useDefault"
          :disabled="disabled"
          @change="toggleDefault(($event.target as HTMLInputElement).checked)"
        />

        {{ t('workspace.settings.prompts.useDefault') }}
      </label>
    </div>

    <div class="mt-3 space-y-2">
      <Label class="text-xs text-muted-foreground">
        {{ t('workspace.settings.prompts.systemPrompt') }}
      </Label>

      <textarea
        :value="entry.useDefault ? defaultBody : entry.body"
        :readonly="entry.useDefault || disabled"
        rows="10"
        :class="
          cn(
            'w-full resize-y rounded-md border border-input bg-background px-3 py-2 font-mono text-xs leading-relaxed outline-none',

            (entry.useDefault || disabled) && 'bg-muted/40 text-muted-foreground'
          )
        "
        @input="updateBody(($event.target as HTMLTextAreaElement).value)"
      />

      <div class="flex justify-end">
        <button
          type="button"
          class="text-xs text-primary underline disabled:opacity-50"
          :disabled="disabled || entry.useDefault"
          @click="resetDefault"
        >
          {{ t('workspace.settings.prompts.resetDefault') }}
        </button>
      </div>
    </div>
  </div>
</template>
