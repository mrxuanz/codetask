<script setup lang="ts">
import { computed, inject, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import ChatComposer from '@renderer/components/home/ChatComposer.vue'
import ChatMessages from '@renderer/components/home/ChatMessages.vue'
import Button from '@renderer/components/ui/Button.vue'
import ErrorAlert from '@renderer/components/ui/ErrorAlert.vue'
import { HomeChatKey } from '@renderer/composables/useHomeChat'
import { isChatThread, useHomeWorkspace } from '@renderer/composables/useHomeWorkspace'
import { getPreferredCoreCode } from '@renderer/lib/preferredCore'

const { t } = useI18n()
const workspace = useHomeWorkspace()

const chatCtx = inject(HomeChatKey)
if (!chatCtx) {
  throw new Error('ThreadMain must be used within HomeLayout with home chat provided')
}
const chat = chatCtx

const messages = computed(() => chatCtx.messages.value)
const cores = computed(() => chatCtx.cores.value)
const activeCoreCode = computed(() => chatCtx.activeCoreCode.value)
const loading = computed(() => chatCtx.loading.value)
const coreSwitching = computed(() => chatCtx.coreSwitching.value)
const sending = computed(() => chatCtx.sending.value)
const streamingMessageId = computed(() => chatCtx.streamingMessageId.value)
const awaitingAssistantReply = computed(() => chatCtx.awaitingAssistantReply.value)
const error = computed(() => chatCtx.error.value)
const runtimeStatus = computed(() => chatCtx.runtimeStatus.value)

const activeProject = computed(
  () =>
    workspace.projects.value.find((project) => project.id === workspace.activeProjectId.value) ??
    null
)

const activeThread = computed(() => {
  const thread =
    workspace.threads.value.find((item) => item.id === workspace.activeThreadId.value) ?? null
  if (!thread || !isChatThread(thread)) return null
  return thread
})

const threadTitle = computed(() => activeThread.value?.title || t('workspace.newThread'))

const currentCoreCode = computed(() => {
  const fromThread = activeCoreCode.value ?? activeThread.value?.coreCode
  if (fromThread) return fromThread
  const preferred = getPreferredCoreCode()
  if (preferred && cores.value.some((core) => core.code === preferred)) {
    return preferred
  }
  return cores.value[0]?.code ?? ''
})

const selectedCore = computed(() => cores.value.find((core) => core.code === currentCoreCode.value))
const coreUnavailable = computed(
  () => cores.value.length > 0 && (!selectedCore.value || !selectedCore.value.available)
)
const busy = computed(
  () => sending.value || runtimeStatus.value === 'running' || coreSwitching.value
)

// Multi-source watch compares each id; a getter that returns `[id, id]` would
  // allocate a new array every run and re-open on syncThread() (blank flash).
  watch(
  [() => activeProject.value?.id, () => activeThread.value?.id],
  ([projectId, threadId]) => {
    if (!projectId || !threadId || !activeThread.value) {
      chat.clear()
      return
    }
    void chat.openThread(activeThread.value)
  },
  { immediate: true }
)

async function handleNewThread(): Promise<void> {
  const projectId = workspace.activeProjectId.value
  if (!projectId) return
  await workspace.createNewThread(projectId)
}

async function handleCoreChange(code: string): Promise<void> {
  const thread = activeThread.value
  if (!thread || code === currentCoreCode.value) return
  const updated = await chat.setCoreCode(thread.id, code)
  if (updated) workspace.syncThread(updated)
}

async function handleSend(payload: { message: string; files: File[] }): Promise<void> {
  const updated = await chat.sendMessage(payload)
  if (updated) workspace.syncThread(updated)
}
</script>

<template>
  <div
    v-if="!activeProject"
    class="flex h-full min-h-0 flex-1 items-center justify-center text-sm text-muted-foreground"
  >
    {{ t('workspace.selectProject') }}
  </div>

  <div v-else-if="!activeThread" class="flex h-full min-h-0 flex-1 flex-col">
    <header class="flex h-12 items-center justify-between border-b border-border px-4">
      <h1 class="text-sm font-medium">{{ activeProject.title }}</h1>
      <Button type="button" variant="outline" size="sm" @click="handleNewThread">
        {{ t('workspace.newThread') }}
      </Button>
    </header>
    <div class="flex flex-1 items-center justify-center text-sm text-muted-foreground">
      {{ t('workspace.noThreadHint') }}
    </div>
  </div>

  <div v-else class="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
    <header
      class="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-border px-4"
    >
      <div class="flex min-w-0 items-center gap-2">
        <h1 class="truncate text-sm font-medium">{{ threadTitle }}</h1>
        <span class="shrink-0 rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground">
          {{ activeProject.title }}
        </span>
        <span v-if="coreSwitching" class="text-xs text-muted-foreground">
          {{ t('workspace.switchingCore') }}
        </span>
        <span v-else-if="busy" class="text-xs text-muted-foreground">
          {{ t('workspace.running') }}
        </span>
        <span v-else-if="runtimeStatus === 'error' && !busy" class="text-xs text-destructive">
          {{ t('workspace.lastRunFailed') }}
        </span>
      </div>
    </header>

    <div v-if="error" class="shrink-0 px-4 pt-3 sm:px-6">
      <ErrorAlert :message="error" />
    </div>

    <div v-if="coreUnavailable" class="shrink-0 px-4 pt-3 sm:px-6">
      <ErrorAlert :message="selectedCore?.reason ?? t('workspace.coreUnavailable')" />
    </div>

    <div class="flex min-h-0 flex-1 flex-col">
      <ChatMessages
        :messages="messages"
        :loading="loading"
        :streaming-message-id="streamingMessageId"
        :pending-reply="awaitingAssistantReply && !streamingMessageId"
      />
      <ChatComposer
        :cores="cores"
        :core-code="currentCoreCode"
        :disabled="loading || coreSwitching || coreUnavailable"
        :sending="busy"
        @core-change="handleCoreChange"
        @send="handleSend"
      />
    </div>
  </div>
</template>
