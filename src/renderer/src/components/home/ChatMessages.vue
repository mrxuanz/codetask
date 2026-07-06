<script setup lang="ts">
import { computed, onMounted, ref, toRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { ConversationMessage } from '@renderer/api/conversation'
import ChatThinkingBlock from '@renderer/components/home/ChatThinkingBlock.vue'
import { useStickToBottom } from '@renderer/composables/useStickToBottom'
import { assetUrlWithAuth } from '@renderer/auth/token'
import { cn } from '@renderer/lib/utils'

const props = defineProps<{
  messages: ConversationMessage[]
  loading?: boolean
  streamingMessageId?: string | null
  pendingReply?: boolean
}>()

const { t } = useI18n()
const scrollRoot = ref<HTMLElement | null>(null)
const { onScroll, scrollToBottom, stickToBottomIfNeeded } = useStickToBottom(scrollRoot)

const visibleMessages = computed(() =>
  props.messages.filter((message) => message.kind !== 'task-launch-draft')
)

const streamingMessageIdRef = toRef(props, 'streamingMessageId')
const pendingReplyRef = toRef(props, 'pendingReply')

watch(
  () => [
    visibleMessages.value.length,
    visibleMessages.value.at(-1)?.id,
    visibleMessages.value.at(-1)?.content,
    visibleMessages.value.at(-1)?.thinking,
    streamingMessageIdRef.value,
    pendingReplyRef.value
  ],
  () => {
    void stickToBottomIfNeeded('auto')
  },
  { flush: 'post' }
)

onMounted(() => {
  void scrollToBottom('auto')
})
</script>

<template>
  <div
    ref="scrollRoot"
    class="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-4 sm:px-6"
    @scroll="onScroll"
  >
    <div
      v-if="loading && visibleMessages.length === 0"
      class="mx-auto w-full max-w-3xl text-sm text-muted-foreground"
    >
      {{ t('workspace.loadingMessages') }}
    </div>

    <div class="mx-auto flex w-full max-w-3xl flex-col gap-4">
      <template v-for="message in visibleMessages" :key="message.id">
        <div :class="cn('flex w-full', message.role === 'user' ? 'justify-end' : 'justify-start')">
          <div
            :class="
              cn(
                'flex w-full flex-col',
                message.role === 'user' ? 'max-w-[80%] items-end' : 'max-w-full items-start'
              )
            "
          >
            <ChatThinkingBlock
              v-if="message.role === 'assistant' && message.thinking?.trim()"
              :content="message.thinking"
              :duration-ms="message.thinkingDurationMs"
              :streaming="streamingMessageId === message.id && !message.content.trim()"
            />
            <div
              v-if="
                message.role !== 'assistant' ||
                message.content.trim() ||
                message.attachments?.length ||
                (streamingMessageId === message.id &&
                  !message.content.trim() &&
                  !message.thinking?.trim())
              "
              :class="
                cn(
                  'w-full whitespace-pre-wrap text-sm leading-relaxed',
                  message.role === 'user'
                    ? 'rounded-2xl border border-border bg-muted px-3 py-2 text-foreground'
                    : cn(
                        'text-foreground',
                        message.thinking?.trim()
                          ? 'mt-3 px-0 py-0'
                          : 'rounded-2xl border border-transparent bg-muted/60 px-3 py-2'
                      )
                )
              "
            >
              <div v-if="message.attachments?.length" class="mb-2 flex flex-wrap gap-2">
                <a
                  v-for="attachment in message.attachments"
                  :key="attachment.id"
                  :href="assetUrlWithAuth(attachment.assetUrl)"
                  target="_blank"
                  rel="noreferrer"
                  class="block overflow-hidden rounded-md border border-border/60"
                >
                  <img
                    v-if="attachment.kind === 'image'"
                    :src="assetUrlWithAuth(attachment.assetUrl)"
                    :alt="attachment.name"
                    class="max-h-40 max-w-full object-cover"
                  />
                  <div v-else class="px-2 py-1 text-xs text-muted-foreground">
                    {{ attachment.name }}
                  </div>
                </a>
              </div>
              <template
                v-if="
                  streamingMessageId === message.id &&
                  message.role === 'assistant' &&
                  !message.content.trim() &&
                  !message.thinking?.trim()
                "
              >
                <span class="inline-flex gap-1 text-muted-foreground" aria-hidden="true">
                  <span class="size-1.5 animate-pulse rounded-full bg-current" />
                  <span
                    class="size-1.5 animate-pulse rounded-full bg-current [animation-delay:150ms]"
                  />
                  <span
                    class="size-1.5 animate-pulse rounded-full bg-current [animation-delay:300ms]"
                  />
                </span>
                <span class="sr-only">{{ t('workspace.running') }}</span>
              </template>
              <template v-else-if="message.content.trim()">{{ message.content }}</template>
            </div>
          </div>
        </div>
      </template>

      <div v-if="pendingReply && !streamingMessageId" class="flex w-full justify-start">
        <div
          class="max-w-[80%] rounded-2xl border border-transparent bg-muted/60 px-3 py-2 text-sm"
        >
          <span class="inline-flex gap-1 text-muted-foreground" aria-hidden="true">
            <span class="size-1.5 animate-pulse rounded-full bg-current" />
            <span class="size-1.5 animate-pulse rounded-full bg-current [animation-delay:150ms]" />
            <span class="size-1.5 animate-pulse rounded-full bg-current [animation-delay:300ms]" />
          </span>
          <span class="sr-only">{{ t('workspace.running') }}</span>
        </div>
      </div>
    </div>
  </div>
</template>
