<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import AppHeader from '@renderer/components/AppHeader.vue'
import FolderBrowsePanel from '@renderer/components/shared/FolderBrowsePanel.vue'
import Button from '@renderer/components/ui/Button.vue'
import Dialog from '@renderer/components/ui/Dialog.vue'
import ErrorAlert from '@renderer/components/ui/ErrorAlert.vue'
import Spinner from '@renderer/components/ui/Spinner.vue'
import {
  createConversationThread,
  createConversationWorkspace,
  deleteConversationThread,
  deleteConversationWorkspace,
  fetchConversationMessages,
  fetchConversationThreads,
  fetchConversationWorkspaces,
  streamConversationTurn,
  type ConversationMessage,
  type ConversationThread,
  type ConversationWorkspace
} from '@renderer/api/conversation'
import { createFilesystemFolder } from '@renderer/api/fs'
import { useBootstrap } from '@renderer/composables/useBootstrap'
import { useFolderBrowse } from '@renderer/composables/useFolderBrowse'
import { translateApiError } from '@renderer/i18n/translateApiError'

const { t } = useI18n()
const { data } = useBootstrap()
const workspaces = ref<ConversationWorkspace[]>([])
const threads = ref<ConversationThread[]>([])
const messages = ref<ConversationMessage[]>([])
const selectedWorkspaceId = ref<string | null>(null)
const selectedThreadId = ref<string | null>(null)
const loading = ref(true)
const messagesLoading = ref(false)
const sending = ref(false)
const prompt = ref('')
const thinking = ref('')
const error = ref<string | null>(null)
const folderOpen = ref(false)
const folderSubmitting = ref(false)
const abortController = ref<AbortController | null>(null)
const folder = useFolderBrowse({ active: folderOpen })

const selectedWorkspace = computed(
  () => workspaces.value.find((item) => item.id === selectedWorkspaceId.value) ?? null
)
const selectedThread = computed(
  () => threads.value.find((item) => item.id === selectedThreadId.value) ?? null
)

function reportError(cause: unknown, fallback: string): void {
  const message = cause instanceof Error ? cause.message : fallback
  error.value = translateApiError(message, t)
}

async function loadMessages(threadId: string): Promise<void> {
  messagesLoading.value = true
  try {
    messages.value = (await fetchConversationMessages(threadId)).data
  } finally {
    messagesLoading.value = false
  }
}

async function selectThread(threadId: string): Promise<void> {
  selectedThreadId.value = threadId
  error.value = null
  try {
    await loadMessages(threadId)
  } catch (cause) {
    reportError(cause, t('conversation.errors.loadMessages'))
  }
}

async function selectWorkspace(workspaceId: string): Promise<void> {
  selectedWorkspaceId.value = workspaceId
  selectedThreadId.value = null
  messages.value = []
  error.value = null
  try {
    threads.value = (await fetchConversationThreads(workspaceId)).data
    const first = threads.value[0]
    if (first) await selectThread(first.id)
  } catch (cause) {
    reportError(cause, t('conversation.errors.loadThreads'))
  }
}

async function loadWorkspaces(preferredId?: string): Promise<void> {
  loading.value = true
  error.value = null
  try {
    workspaces.value = (await fetchConversationWorkspaces()).data
    const target =
      workspaces.value.find((item) => item.id === preferredId) ??
      workspaces.value.find((item) => item.id === selectedWorkspaceId.value) ??
      workspaces.value[0]
    if (target) await selectWorkspace(target.id)
    else {
      selectedWorkspaceId.value = null
      selectedThreadId.value = null
      threads.value = []
      messages.value = []
    }
  } catch (cause) {
    reportError(cause, t('conversation.errors.loadWorkspaces'))
  } finally {
    loading.value = false
  }
}

async function newThread(): Promise<ConversationThread | null> {
  const workspaceId = selectedWorkspaceId.value
  if (!workspaceId) return null
  error.value = null
  try {
    const created = (await createConversationThread(workspaceId)).data
    threads.value = [created, ...threads.value]
    await selectThread(created.id)
    return created
  } catch (cause) {
    reportError(cause, t('conversation.errors.createThread'))
    return null
  }
}

function openFolderPicker(): void {
  folderOpen.value = true
  void nextTick(() => folder.start())
}

async function addWorkspace(path: string): Promise<void> {
  if (!path.trim()) return
  folderSubmitting.value = true
  error.value = null
  try {
    const created = (await createConversationWorkspace(path)).data
    folderOpen.value = false
    await loadWorkspaces(created.id)
  } catch (cause) {
    reportError(cause, t('conversation.errors.addWorkspace'))
  } finally {
    folderSubmitting.value = false
  }
}

async function createFolderAndAdd(): Promise<void> {
  const parentPath = folder.currentDirectoryPath()
  const name = folder.newFolderName.value.trim()
  if (!parentPath || !name) return
  folderSubmitting.value = true
  folder.error.value = null
  try {
    const created = await createFilesystemFolder(parentPath, name)
    await addWorkspace(created.data.path)
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : t('folderPicker.addFailed')
    folder.error.value = translateApiError(message, t)
  } finally {
    folderSubmitting.value = false
  }
}

async function removeWorkspace(workspace: ConversationWorkspace): Promise<void> {
  if (!window.confirm(t('conversation.confirmRemoveWorkspace', { name: workspace.title }))) return
  try {
    await deleteConversationWorkspace(workspace.id)
    await loadWorkspaces()
  } catch (cause) {
    reportError(cause, t('conversation.errors.removeWorkspace'))
  }
}

async function removeThread(thread: ConversationThread): Promise<void> {
  if (!window.confirm(t('conversation.confirmDeleteThread', { name: thread.title }))) return
  try {
    await deleteConversationThread(thread.id)
    if (selectedWorkspaceId.value) await selectWorkspace(selectedWorkspaceId.value)
  } catch (cause) {
    reportError(cause, t('conversation.errors.deleteThread'))
  }
}

async function send(): Promise<void> {
  const content = prompt.value.trim()
  if (!content || sending.value || !selectedWorkspaceId.value) return
  let thread = selectedThread.value
  if (!thread) thread = await newThread()
  if (!thread) return

  prompt.value = ''
  error.value = null
  thinking.value = ''
  sending.value = true
  const userMessage: ConversationMessage = {
    id: `local-user-${Date.now()}`,
    threadId: thread.id,
    role: 'user',
    content,
    sequence: messages.value.length + 1,
    createdAtMs: Date.now()
  }
  const assistantMessage: ConversationMessage = {
    id: `local-assistant-${Date.now()}`,
    threadId: thread.id,
    role: 'assistant',
    content: '',
    sequence: messages.value.length + 2,
    createdAtMs: Date.now()
  }
  messages.value = [...messages.value, userMessage, assistantMessage]
  const controller = new AbortController()
  abortController.value = controller

  try {
    await streamConversationTurn(
      thread.id,
      content,
      (event) => {
        if (event.type === 'delta') assistantMessage.content += event.content
        if (event.type === 'thinking') thinking.value += event.content
        if (event.type === 'completed') {
          assistantMessage.id = event.messageId
          assistantMessage.content = event.reply
        }
      },
      controller.signal
    )
    await loadMessages(thread.id)
    if (selectedWorkspaceId.value) {
      threads.value = (await fetchConversationThreads(selectedWorkspaceId.value)).data
    }
  } catch (cause) {
    if (controller.signal.aborted) {
      error.value = t('conversation.cancelled')
    } else {
      reportError(cause, t('conversation.errors.send'))
    }
    await loadMessages(thread.id).catch(() => undefined)
  } finally {
    abortController.value = null
    thinking.value = ''
    sending.value = false
  }
}

function cancelTurn(): void {
  abortController.value?.abort(new Error('conversation.cancelled'))
}

onMounted(() => {
  void loadWorkspaces()
})
</script>

<template>
  <main class="flex h-full min-h-0 flex-col bg-background">
    <AppHeader :username="data?.username" />
    <div class="flex min-h-0 flex-1">
      <aside class="flex w-72 shrink-0 flex-col border-r border-border bg-card">
        <div class="flex items-center justify-between gap-2 border-b border-border p-3">
          <span class="text-sm font-semibold">{{ t('conversation.workspaces') }}</span>
          <Button size="sm" variant="outline" @click="openFolderPicker">
            {{ t('conversation.addFolder') }}
          </Button>
        </div>
        <div class="min-h-0 flex-1 overflow-y-auto p-2">
          <div v-if="loading" class="flex justify-center p-6"><Spinner /></div>
          <p
            v-else-if="workspaces.length === 0"
            class="px-2 py-8 text-center text-sm text-muted-foreground"
          >
            {{ t('conversation.noWorkspace') }}
          </p>
          <div v-for="workspace in workspaces" :key="workspace.id" class="mb-2">
            <div
              class="group flex items-center rounded-md"
              :class="selectedWorkspaceId === workspace.id ? 'bg-muted' : 'hover:bg-muted/70'"
            >
              <button
                type="button"
                class="min-w-0 flex-1 px-2 py-2 text-left"
                @click="selectWorkspace(workspace.id)"
              >
                <span class="block truncate text-sm font-medium">📁 {{ workspace.title }}</span>
                <span class="block truncate text-[11px] text-muted-foreground">
                  {{ workspace.rootPath }}
                </span>
              </button>
              <button
                type="button"
                class="px-2 text-muted-foreground opacity-0 group-hover:opacity-100"
                :aria-label="t('common.delete')"
                @click="removeWorkspace(workspace)"
              >
                ×
              </button>
            </div>
            <div
              v-if="selectedWorkspaceId === workspace.id"
              class="ml-3 border-l border-border pl-2"
            >
              <button
                type="button"
                class="my-1 w-full rounded px-2 py-1.5 text-left text-xs font-medium hover:bg-muted"
                @click="newThread"
              >
                ＋ {{ t('conversation.newThread') }}
              </button>
              <div
                v-for="thread in threads"
                :key="thread.id"
                class="group flex items-center rounded"
                :class="selectedThreadId === thread.id ? 'bg-muted' : 'hover:bg-muted/70'"
              >
                <button
                  type="button"
                  class="min-w-0 flex-1 truncate px-2 py-1.5 text-left text-xs"
                  @click="selectThread(thread.id)"
                >
                  {{ thread.title }}
                </button>
                <button
                  type="button"
                  class="px-1.5 text-muted-foreground opacity-0 group-hover:opacity-100"
                  @click="removeThread(thread)"
                >
                  ×
                </button>
              </div>
            </div>
          </div>
        </div>
      </aside>

      <section class="flex min-w-0 flex-1 flex-col">
        <div class="flex h-14 shrink-0 items-center border-b border-border px-4">
          <div class="min-w-0">
            <h1 class="truncate text-sm font-semibold">
              {{ selectedThread?.title ?? selectedWorkspace?.title ?? t('conversation.title') }}
            </h1>
            <p v-if="selectedWorkspace" class="truncate text-xs text-muted-foreground">
              {{ selectedWorkspace.rootPath }}
            </p>
          </div>
        </div>

        <div class="min-h-0 flex-1 overflow-y-auto">
          <div class="mx-auto w-full max-w-4xl space-y-5 p-4 sm:p-6">
            <ErrorAlert v-if="error" :message="error" />
            <div v-if="messagesLoading" class="flex justify-center py-10"><Spinner /></div>
            <div
              v-else-if="!selectedWorkspace"
              class="rounded-xl border border-dashed border-border p-10 text-center"
            >
              <h2 class="font-semibold">{{ t('conversation.emptyTitle') }}</h2>
              <p class="mt-2 text-sm text-muted-foreground">
                {{ t('conversation.emptyDescription') }}
              </p>
              <Button class="mt-4" @click="openFolderPicker">
                {{ t('conversation.chooseFolder') }}
              </Button>
            </div>
            <div
              v-else-if="messages.length === 0"
              class="py-16 text-center text-sm text-muted-foreground"
            >
              {{ t('conversation.startHint') }}
            </div>
            <article
              v-for="message in messages"
              :key="message.id"
              class="flex"
              :class="message.role === 'user' ? 'justify-end' : 'justify-start'"
            >
              <div
                class="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl px-4 py-3 text-sm leading-6"
                :class="
                  message.role === 'user'
                    ? 'bg-primary text-primary-foreground'
                    : 'border border-border bg-card'
                "
              >
                {{ message.content || (sending ? t('conversation.waiting') : '') }}
              </div>
            </article>
            <p v-if="thinking" class="text-xs text-muted-foreground">
              {{ t('conversation.thinking') }}
            </p>
          </div>
        </div>

        <div class="shrink-0 border-t border-border bg-card p-3 sm:p-4">
          <div class="mx-auto flex max-w-4xl items-end gap-2">
            <textarea
              v-model="prompt"
              rows="2"
              class="min-h-12 max-h-40 min-w-0 flex-1 resize-y rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
              :disabled="!selectedWorkspace || sending"
              :placeholder="
                selectedWorkspace
                  ? t('conversation.promptPlaceholder')
                  : t('conversation.chooseWorkspaceFirst')
              "
              @keydown.enter.exact.prevent="send"
            />
            <Button v-if="sending" variant="outline" @click="cancelTurn">
              {{ t('conversation.stop') }}
            </Button>
            <Button v-else :disabled="!selectedWorkspace || !prompt.trim()" @click="send">
              {{ t('conversation.send') }}
            </Button>
          </div>
        </div>
      </section>
    </div>

    <Dialog
      :open="folderOpen"
      class="flex h-[min(42rem,85dvh)] flex-col"
      @close="folderOpen = false"
    >
      <div class="border-b border-border px-4 py-3">
        <h2 class="font-semibold">{{ t('conversation.folderDialogTitle') }}</h2>
        <p class="mt-1 text-xs text-muted-foreground">
          {{ t('conversation.folderDialogDescription') }}
        </p>
      </div>
      <FolderBrowsePanel
        v-model:query="folder.query.value"
        v-model:new-folder-name="folder.newFolderName.value"
        :parent-path="folder.parentPath.value"
        :current-path="folder.currentDirectoryPath()"
        :entries="folder.entries.value"
        :loading="folder.loading.value"
        :submitting="folderSubmitting"
        :error="folder.error.value"
        :show-create-folder="true"
        :select-current-label="t('conversation.addSelectedFolder')"
        :create-folder-label="t('conversation.createAndAddFolder')"
        fill-height
        @go-parent="folder.goParent"
        @open-entry="folder.openEntry"
        @select="addWorkspace"
        @create-folder="createFolderAndAdd"
      />
    </Dialog>
  </main>
</template>
