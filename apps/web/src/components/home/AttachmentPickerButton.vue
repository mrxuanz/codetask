<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { cn } from '@renderer/lib/utils'

const { t } = useI18n()

defineProps<{
  disabled?: boolean
  title?: string
}>()

const emit = defineEmits<{
  click: []
}>()
</script>

<template>
  <button
    type="button"
    :disabled="disabled"
    :title="title ?? t('workspace.composer.addAttachment')"
    :class="
      cn(
        'inline-flex size-8 items-center justify-center rounded-lg border border-border bg-muted/40 text-foreground transition-colors',
        'hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50'
      )
    "
    @click="emit('click')"
  >
    <svg viewBox="0 0 24 24" class="size-4" aria-hidden fill="none">
      <path
        d="M8.5 13.5 14.2 7.8a2.8 2.8 0 1 1 4 4l-6.8 6.7a4.2 4.2 0 0 1-5.9-5.9l7.4-7.3a6 6 0 0 1 8.5 8.5l-7.8 7.7"
        stroke="currentColor"
        stroke-width="1.75"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  </button>
</template>
