<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronDown, ChevronRight } from 'lucide-vue-next'
import { thinkingDurationSeconds } from '@shared/message-thinking'
import { cn } from '@renderer/lib/utils'

const props = defineProps<{
  content: string
  streaming?: boolean
  /** Persisted duration from backend (ms). Used after reload. */
  durationMs?: number | null
}>()

const { t } = useI18n()
const open = ref(false)
const startedAt = ref<number | null>(null)
const liveElapsedSeconds = ref<number | null>(null)

const panelId = `thinking-panel-${Math.random().toString(36).slice(2, 9)}`

const elapsedSeconds = computed(() => {
  if (props.streaming && liveElapsedSeconds.value != null) {
    return liveElapsedSeconds.value
  }
  return thinkingDurationSeconds(props.durationMs)
})

const headerLabel = computed(() => {
  if (props.streaming) {
    return t('workspace.composer.thinkingStreaming')
  }
  const seconds = elapsedSeconds.value
  if (seconds != null) {
    return t('workspace.composer.thinkingDoneWithDuration', {
      duration: t('workspace.composer.thinkingDurationSeconds', { n: seconds })
    })
  }
  return t('workspace.composer.thinkingDone')
})

watch(
  () => props.streaming,
  (isStreaming) => {
    if (isStreaming) {
      startedAt.value = Date.now()
      liveElapsedSeconds.value = null
      open.value = true
      return
    }
    if (startedAt.value != null) {
      liveElapsedSeconds.value = Math.max(1, Math.round((Date.now() - startedAt.value) / 1000))
      open.value = false
    }
  },
  { immediate: true }
)
</script>

<template>
  <div class="w-full">
    <button
      type="button"
      class="inline-flex max-w-full items-center gap-1.5 py-0.5 text-left text-sm text-muted-foreground transition-colors hover:text-foreground/80"
      :aria-expanded="open"
      :aria-controls="panelId"
      @click="open = !open"
    >
      <span class="font-normal">{{ headerLabel }}</span>
      <ChevronDown
        v-if="open"
        class="size-3.5 shrink-0 text-muted-foreground/60"
        aria-hidden="true"
      />
      <ChevronRight v-else class="size-3.5 shrink-0 text-muted-foreground/60" aria-hidden="true" />
    </button>
    <div
      v-show="open"
      :id="panelId"
      role="region"
      :aria-label="t('workspace.composer.thinking')"
      class="relative mt-2 pl-4"
    >
      <div class="absolute bottom-1 left-0 top-1 w-px bg-border" aria-hidden="true" />
      <div
        :class="
          cn(
            'max-h-72 overflow-y-auto overscroll-contain whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground',
            streaming && 'animate-pulse'
          )
        "
      >
        {{ content }}
      </div>
    </div>
  </div>
</template>
