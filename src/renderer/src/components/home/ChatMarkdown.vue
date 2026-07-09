<script setup lang="ts">
import { computed } from 'vue'
import { renderChatMarkdown } from '@renderer/lib/chatMarkdown'
import { cn } from '@renderer/lib/utils'

const props = withDefaults(
  defineProps<{
    text: string
    /** Treat single newlines as hard breaks (user chat style). */
    breaks?: boolean
    streaming?: boolean
    class?: string
  }>(),
  {
    breaks: false,
    streaming: false
  }
)

const html = computed(() =>
  renderChatMarkdown(props.text, {
    breaks: props.breaks,
    streaming: props.streaming
  })
)
</script>

<template>
  <div
    :class="cn('chat-markdown w-full min-w-0 text-sm leading-relaxed text-foreground', props.class)"
    v-html="html"
  />
</template>
