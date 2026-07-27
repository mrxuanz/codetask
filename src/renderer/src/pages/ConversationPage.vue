<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { SupportedCoreCode } from '@shared/providers/codes'
import Button from '@renderer/components/ui/Button.vue'
import ErrorAlert from '@renderer/components/ui/ErrorAlert.vue'
import Spinner from '@renderer/components/ui/Spinner.vue'
import {
  fetchConversationMessages,
  streamConversationTurn,
  type ConversationMessage,
  type ConversationStreamEvent
} from '@renderer/api/conversation'
import { useHomeWorkspace } from '@renderer/composables/useHomeWorkspace'
import { translateApiError } from '@renderer/i18n/translateApiError'

const { t } = useI18n()
const workspace = useHomeWorkspace()
const messages = ref<ConversationMessage[]>([])
const prompt = ref('')
const thinking = ref('')
const loading = ref(false)
const error = ref<string | null>(null)
const messageViewport = ref<HTMLElement | null>(null)
const activeTurns = new Map<string, AbortController>()
const activeTurnIds = ref<Set<string>>(new Set())

const selectedThread = workspace.selectedThread
const selectedWorkspace = workspace.selectedWorkspace
const provider = computed(() =>
  workspace.providers.value.find((candidate) => candidate.code === selectedThread.value?.provider)
)
const activeThreadRunning = computed(() =>
  selectedThread.value ? activeTurnIds.value.has(selectedThread.value.id) : false
)
const selectableProviders = computed(() =>
  workspace.providers.value.filter((candidate) => candidate.installed && candidate.authenticated)
)

function markTurn(threadId: string, active: boolean): void {
  const next = new Set(activeTurnIds.value)
  if (active) next.add(threadId)
  else next.delete(threadId)
  activeTurnIds.value = next
}

async function scrollToBottom(): Promise<void> {
  await nextTick()
  const element = messageViewport.value
  if (element) element.scrollTop = element.scrollHeight
}

async function loadMessages(threadId: string): Promise<void> {
  loading.value = true
  error.value = null
  try {
    messages.value = (await fetchConversationMessages(threadId)).data
    await scrollToBottom()
  } catch (cause) {
    error.value = translateApiError(cause instanceof Error ? cause.message : String(cause), t)
  } finally {
    loading.value = false
  }
}

watch(
  () => workspace.selectedThreadId.value,
  (threadId) => {
    messages.value = []
    thinking.value = ''
    error.value = null
    if (threadId) void loadMessages(threadId)
  },
  { immediate: true }
)

async function switchProvider(event: Event): Promise<void> {
  const thread = selectedThread.value
  const target = (event.target as HTMLSelectElement).value as SupportedCoreCode
  if (!thread || target === thread.provider || activeTurns.has(thread.id)) return
  error.value = null
  try {
    await workspace.switchThreadProvider(thread.id, target)
  } catch (cause) {
    error.value = translateApiError(cause instanceof Error ? cause.message : String(cause), t)
  }
}

function applyEvent(threadId: string, event: ConversationStreamEvent): void {
  if (workspace.selectedThreadId.value !== threadId) return
  if (event.type === 'thinking') {
    thinking.value += event.content
    return
  }
  if (event.type === 'delta') {
    const streamingId = `streaming-${threadId}`
    const existing = messages.value.find((message) => message.id === streamingId)
    if (existing) {
      messages.value = messages.value.map((message) =>
        message.id === streamingId ? { ...message, content: message.content + event.content } : message
      )
    } else {
      messages.value = [
        ...messages.value,
        {
          id: streamingId,
          threadId,
          role: 'assistant',
          content: event.content,
          sequence: Number.MAX_SAFE_INTEGER,
          createdAtMs: Date.now()
        }
      ]
    }
    void scrollToBottom()
  }
}

async function send(): Promise<void> {
  const thread = selectedThread.value
  const workspaceId = selectedWorkspace.value?.id
  const text = prompt.value.trim()
  if (!thread || !workspaceId || !text || activeTurns.has(thread.id)) return

  const threadId = thread.id
  prompt.value = ''
  thinking.value = ''
  error.value = null
  messages.value = [
    ...messages.value,
    {
      id: `optimistic-${Date.now()}`,
      threadId,
      role: 'user',
      content: text,
      sequence: Number.MAX_SAFE_INTEGER - 1,
      createdAtMs: Date.now()
    }
  ]
  await scrollToBottom()

  const controller = new AbortController()
  activeTurns.set(threadId, controller)
  markTurn(threadId, true)
  try {
    await streamConversationTurn(threadId, text, (event) => applyEvent(threadId, event), controller.signal)
    if (workspace.selectedThreadId.value === threadId) await loadMessages(threadId)
    await workspace.refreshWorkspace(workspaceId)
  } catch (cause) {
    if (workspace.selectedThreadId.value === threadId && !controller.signal.aborted) {
      error.value = translateApiError(cause instanceof Error ? cause.message : String(cause), t)
      await loadMessages(threadId).catch(() => undefined)
    }
  } finally {
    activeTurns.delete(threadId)
    markTurn(threadId, false)
  }
}

function stop(): void {
  const threadId = selectedThread.value?.id
  if (threadId) activeTurns.get(threadId)?.abort()
}
</script>

<template>
  <section class="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
    <header
      v-if="selectedThread"
      class="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-border px-4"
    >
      <div class="min-w-0">
        <h1 class="truncate text-sm font-semibold">{{ selectedThread.title }}</h1>
        <p class="truncate text-xs text-muted-foreground">{{ selectedWorkspace?.rootPath }}</p>
      </div>
      <div class="flex items-center gap-2">
        <span v-if="activeThreadRunning" class="text-xs text-muted-foreground">
          {{ t('conversation.running') }}
        </span>
        <select
          :value="selectedThread.provider"
          :disabled="activeThreadRunning"
          class="h-9 rounded-md border border-border bg-background px-3 text-sm"
          :aria-label="t('conversation.chooseProvider')"
          @change="switchProvider"
        >
          <option
            v-for="candidate in selectableProviders"
            :key="candidate.code"
            :value="candidate.code"
          >
            {{ candidate.label }} · {{ candidate.protocol }}
          </option>
        </select>
      </div>
    </header>

    <div
      v-if="!selectedWorkspace"
      class="flex flex-1 items-center justify-center p-8 text-center"
    >
      <div>
        <h1 class="text-lg font-semibold">{{ t('conversation.emptyTitle') }}</h1>
        <p class="mt-2 max-w-md text-sm text-muted-foreground">
          {{ t('conversation.emptyDescription') }}
        </p>
        <Button class="mt-4" @click="workspace.folderDialogOpen.value = true">
          {{ t('conversation.chooseFolder') }}
        </Button>
      </div>
    </div>

    <div
      v-else-if="!selectedThread"
      class="flex flex-1 items-center justify-center p-8 text-center"
    >
      <div>
        <h1 class="text-lg font-semibold">{{ selectedWorkspace.title }}</h1>
        <p class="mt-2 text-sm text-muted-foreground">
          {{ t('conversation.createThreadFromSidebar') }}
        </p>
      </div>
    </div>

    <template v-else>
      <div v-if="selectedWorkspace.workspaceAccess === 'read-only'" class="shrink-0 px-4 pt-3">
        <p class="rounded-lg border border-amber-400/50 bg-amber-500/10 px-3 py-2 text-xs">
          {{ t('conversation.jobReadOnly') }}
        </p>
      </div>
      <div v-if="error" class="shrink-0 px-4 pt-3"><ErrorAlert :message="error" /></div>

      <div ref="messageViewport" class="min-h-0 flex-1 overflow-y-auto">
        <div class="mx-auto max-w-4xl space-y-5 px-4 py-6">
          <div v-if="loading" class="flex justify-center py-10"><Spinner /></div>
          <div
            v-else-if="messages.length === 0"
            class="rounded-xl border border-dashed border-border p-10 text-center text-sm text-muted-foreground"
          >
            {{ t('conversation.noMessages') }}
          </div>
          <article
            v-for="message in messages"
            :key="message.id"
            class="flex"
            :class="message.role === 'user' ? 'justify-end' : 'justify-start'"
          >
            <div
              class="max-w-[85%] whitespace-pre-wrap rounded-2xl px-4 py-3 text-sm leading-6"
              :class="
                message.role === 'user'
                  ? 'bg-primary text-primary-foreground'
                  : 'border border-border bg-card'
              "
            >
              {{ message.content }}
            </div>
          </article>
          <details v-if="thinking" class="rounded-lg border border-border bg-muted/30 p-3 text-xs">
            <summary class="cursor-pointer font-medium">{{ t('conversation.thinking') }}</summary>
            <pre class="mt-2 whitespace-pre-wrap text-muted-foreground">{{ thinking }}</pre>
          </details>
        </div>
      </div>

      <div class="shrink-0 border-t border-border bg-background p-3">
        <div class="mx-auto flex max-w-4xl items-end gap-2">
          <textarea
            v-model="prompt"
            rows="2"
            class="min-h-12 flex-1 resize-none rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
            :placeholder="t('conversation.promptPlaceholder')"
            :disabled="activeThreadRunning || !provider?.authenticated"
            @keydown.enter.exact.prevent="send"
          />
          <Button v-if="activeThreadRunning" variant="outline" @click="stop">
            {{ t('conversation.stop') }}
          </Button>
          <Button v-else :disabled="!prompt.trim() || !provider?.authenticated" @click="send">
            {{ t('conversation.send') }}
          </Button>
        </div>
        <p v-if="provider && !provider.authenticated" class="mx-auto mt-2 max-w-4xl text-xs text-destructive">
          {{ provider.message }} · <code>{{ provider.loginCommand }}</code>
        </p>
      </div>
    </template>
  </section>
</template>
