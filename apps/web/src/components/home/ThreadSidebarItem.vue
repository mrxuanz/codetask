<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { HomeThread } from '@renderer/composables/useHomeWorkspace'
import { cn } from '@renderer/lib/utils'

const props = defineProps<{
  thread: HomeThread
  active: boolean
}>()

defineEmits<{
  select: []
  contextmenu: [event: MouseEvent]
}>()

const { t } = useI18n()

const title = computed(() => props.thread.title || t('workspace.newThread'))

const relativeTime = computed(() => {
  const updatedAt = props.thread.updatedAt
  const now = Math.floor(Date.now() / 1000)
  const diff = Math.max(0, now - updatedAt)
  if (diff < 3600) {
    return t('workspace.relativeMinutes', { n: Math.max(1, Math.floor(diff / 60)) })
  }
  return t('workspace.relativeHours', { n: Math.floor(diff / 3600) })
})
</script>

<template>
  <button
    type="button"
    :class="
      cn(
        'flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted',
        active && 'bg-muted'
      )
    "
    @click="$emit('select')"
    @contextmenu="$emit('contextmenu', $event)"
  >
    <span class="truncate">{{ title }}</span>
    <span class="shrink-0 text-xs text-muted-foreground">{{ relativeTime }}</span>
  </button>
</template>
