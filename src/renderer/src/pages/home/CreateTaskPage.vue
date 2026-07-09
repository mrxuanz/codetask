<script setup lang="ts">
import { computed, inject, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import CreateDraftList, {
  type DraftListEntry
} from '@renderer/components/create/CreateDraftList.vue'
import CreateTaskCompletedView from '@renderer/components/create/CreateTaskCompletedView.vue'
import CreateTaskProjectDialog from '@renderer/components/create/CreateTaskProjectDialog.vue'
import DraftPlanWorkspace from '@renderer/components/workspace/DraftPlanWorkspace.vue'
import ChatComposer from '@renderer/components/home/ChatComposer.vue'
import ChatMessages from '@renderer/components/home/ChatMessages.vue'
import Button from '@renderer/components/ui/Button.vue'
import ErrorAlert from '@renderer/components/ui/ErrorAlert.vue'
import { HomeChatKey } from '@renderer/composables/useHomeChat'
import { discardEmptyCreateTaskThread } from '@renderer/api/threads'
import {
  THREAD_KIND_CREATE_TASK,
  isCreateTaskThread,
  useHomeWorkspace
} from '@renderer/composables/useHomeWorkspace'
import { getPreferredCoreCode } from '@renderer/lib/preferredCore'

type Phase = 'list' | 'workspace' | 'completed'

interface CompletedContext {
  threadId: string
  draftMessageId: string
  jobId: string
  title: string
}

const { t } = useI18n()
const workspace = useHomeWorkspace()

const chatCtx = inject(HomeChatKey)
if (!chatCtx) {
  throw new Error('CreateTaskPage must be used within HomeLayout with home chat provided')
}
const chat = chatCtx

const phase = ref<Phase>('list')
const pickingProject = ref(false)
const resumeDraftId = ref<string | null>(null)
const completedContext = ref<CompletedContext | null>(null)
const draftWorkspaceRef = ref<InstanceType<typeof DraftPlanWorkspace> | null>(null)
const draftListRef = ref<InstanceType<typeof CreateDraftList> | null>(null)
const createProjectDialogOpen = ref(false)
/** Mirrors DraftPlanWorkspace first-load gate (reactive via workspaceReadyChange). */
const workspaceReady = ref(false)

const messages = computed(() => chat.messages.value)
const cores = computed(() => chat.cores.value)
const activeCoreCode = computed(() => chat.activeCoreCode.value)
const loading = computed(() => chat.loading.value)
const coreSwitching = computed(() => chat.coreSwitching.value)
const sending = computed(() => chat.sending.value)
const streamingMessageId = computed(() => chat.streamingMessageId.value)
const awaitingAssistantReply = computed(() => chat.awaitingAssistantReply.value)
const error = computed(() => chat.error.value)
const runtimeStatus = computed(() => chat.runtimeStatus.value)

const activeProject = computed(
  () =>
    workspace.projects.value.find((project) => project.id === workspace.activeProjectId.value) ??
    null
)

const activeThread = computed(
  () =>
    workspace.threads.value.find((thread) => thread.id === workspace.activeThreadId.value) ?? null
)

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

/** Block send until the right-hand workspace finishes its first load for this thread. */
const workspaceNotReady = computed(
  () => phase.value === 'workspace' && Boolean(activeThread.value) && !workspaceReady.value
)

const composerDisabled = computed(
  () =>
    loading.value ||
    coreSwitching.value ||
    coreUnavailable.value ||
    workspaceNotReady.value
)

// Multi-source watch: avoid `() => [id, id]` (new array each run → blank flash on sync).
  watch(
  [() => phase.value, () => activeProject.value?.id, () => activeThread.value?.id],
  ([currentPhase, projectId, threadId]) => {
    if (currentPhase !== 'workspace' || !projectId || !threadId || !activeThread.value) {
      return
    }
    void chat.openThread(activeThread.value)
  },
  { immediate: true }
)

watch(
  () => workspace.activeThreadId.value,
  (threadId) => {
    if (!threadId || phase.value === 'completed') return
    const thread = workspace.threads.value.find((item) => item.id === threadId)
    if (!thread || !isCreateTaskThread(thread)) return
    resumeDraftId.value = thread.activeDraftId ?? null
    completedContext.value = null
    phase.value = 'workspace'
  }
)

watch(
  () => phase.value,
  (currentPhase, previousPhase) => {
    if (previousPhase === 'workspace' && currentPhase !== 'workspace') {
      stopWorkspaceStreams()
      workspaceReady.value = false
    }
  }
)

onBeforeUnmount(() => {
  stopWorkspaceStreams()
})

watch(
  () => messages.value.filter((m) => m.kind === 'task-launch-draft').map((m) => m.id),
  (ids, prev) => {
    if (phase.value !== 'workspace' || !draftWorkspaceRef.value) return
    const prevSet = new Set(prev ?? [])
    const newId = ids.find((id) => !prevSet.has(id))
    if (newId) void draftWorkspaceRef.value.onDraftCreated(newId)
  }
)

function handleWorkspaceReadyChange(ready: boolean): void {
  workspaceReady.value = ready
}

function stopWorkspaceStreams(): void {
  draftWorkspaceRef.value?.stopPlanStream?.()
}

function goToList(): void {
  stopWorkspaceStreams()
  const thread = activeThread.value
  const hadMessages = messages.value.length > 0
  resumeDraftId.value = null
  completedContext.value = null
  phase.value = 'list'
  void (async () => {
    if (thread && isCreateTaskThread(thread) && !hadMessages) {
      try {
        const res = await discardEmptyCreateTaskThread(thread.id)
        if (res.data.discarded) {
          workspace.threads.value = workspace.threads.value.filter((item) => item.id !== thread.id)
        }
      } catch {
        // best-effort cleanup; janitor will retry
      }
    }
    workspace.setActiveThreadId(null)
    await nextTick()
    void draftListRef.value?.reload()
  })()
}

function openCompleted(entry: DraftListEntry): void {
  const jobId = entry.jobId ?? entry.linkedPlanId ?? entry.plan?.id
  if (!jobId) return
  completedContext.value = {
    threadId: entry.threadId,
    draftMessageId: entry.messageId,
    jobId,
    title: entry.title
  }
  phase.value = 'completed'
}

function resolveCompletedJobId(entry: DraftListEntry): string | null {
  return entry.jobId ?? entry.linkedPlanId ?? entry.plan?.id ?? null
}

function handleContinueDraft(entry: DraftListEntry): void {
  workspace.setActiveProjectId(entry.projectId)
  workspace.setActiveThreadId(entry.threadId)
  resumeDraftId.value = entry.messageId
  const completedJobId = resolveCompletedJobId(entry)
  if (entry.launched && completedJobId) {
    openCompleted(entry)
    return
  }
  completedContext.value = null
  phase.value = 'workspace'
}

function handleCreateNew(): void {
  resumeDraftId.value = null
  completedContext.value = null
  workspace.setActiveThreadId(null)
  createProjectDialogOpen.value = true
}

function closeCreateProjectDialog(): void {
  createProjectDialogOpen.value = false
}

async function handleSelectProject(projectId: string): Promise<void> {
  pickingProject.value = true
  try {
    workspace.setActiveProjectId(projectId)
    await workspace.createNewThread(projectId, THREAD_KIND_CREATE_TASK)
    resumeDraftId.value = null
    completedContext.value = null
    createProjectDialogOpen.value = false
    phase.value = 'workspace'
  } finally {
    pickingProject.value = false
  }
}

async function handleAddProject(workspaceRoot: string): Promise<void> {
  pickingProject.value = true
  try {
    await workspace.addLocalProject(workspaceRoot, { threadKind: THREAD_KIND_CREATE_TASK })
    resumeDraftId.value = null
    completedContext.value = null
    createProjectDialogOpen.value = false
    phase.value = 'workspace'
  } finally {
    pickingProject.value = false
  }
}

async function handleCoreChange(code: string): Promise<void> {
  const thread = activeThread.value
  if (!thread || code === currentCoreCode.value) return
  const updated = await chat.setCoreCode(thread.id, code)
  if (updated) workspace.syncThread(updated)
}

async function handleSend(payload: { message: string; files: File[] }): Promise<void> {
  if (composerDisabled.value) return
  const updated = await chat.sendMessage({
    ...payload,
    createTaskMode: true,
    onPlanUpdated: () => {
      void draftWorkspaceRef.value?.loadWorkspace?.()
    }
  })
  if (updated) workspace.syncThread(updated)
}

function handleDraftUpdated(
  message: import('@renderer/api/conversation').ConversationMessage
): void {
  chat.updateDraftMessage(message)
}

function handlePlanConfirmed(payload: {
  jobId: string
  draftMessageId: string
  title: string
}): void {
  if (!activeThread.value) return
  completedContext.value = {
    threadId: activeThread.value.id,
    draftMessageId: payload.draftMessageId,
    jobId: payload.jobId,
    title: payload.title
  }
  phase.value = 'completed'
}
</script>

<template>
  <div class="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
    <header
      class="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-border px-4"
    >
      <div class="flex min-w-0 items-center gap-2">
        <h1 class="truncate text-sm font-medium">{{ t('workspace.nav.createTask') }}</h1>
        <span
          v-if="activeProject && (phase === 'workspace' || phase === 'completed')"
          class="shrink-0 rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground"
        >
          {{ activeProject.title }}
        </span>
      </div>
      <div
        v-if="phase === 'workspace' || phase === 'completed'"
        class="flex shrink-0 items-center gap-2"
      >
        <Button type="button" variant="outline" size="sm" @click="goToList">
          {{ t('workspace.create.backToDraftList') }}
        </Button>
      </div>
    </header>

    <div v-if="phase === 'list'" class="min-h-0 flex-1 overflow-y-auto">
      <CreateDraftList
        ref="draftListRef"
        @continue-draft="handleContinueDraft"
        @create-new="handleCreateNew"
      />
    </div>

    <div
      v-else-if="phase === 'completed' && completedContext"
      class="min-h-0 flex-1 overflow-y-auto"
    >
      <CreateTaskCompletedView
        :thread-id="completedContext.threadId"
        :draft-message-id="completedContext.draftMessageId"
        :job-id="completedContext.jobId"
        :title="completedContext.title"
      />
    </div>

    <template v-else-if="activeThread">
      <div v-if="error" class="shrink-0 px-4 pt-3 sm:px-6">
        <ErrorAlert :message="error" />
      </div>

      <div v-if="coreUnavailable" class="shrink-0 px-4 pt-3 sm:px-6">
        <ErrorAlert :message="selectedCore?.reason ?? t('workspace.coreUnavailable')" />
      </div>

      <div class="flex min-h-0 flex-1">
        <div class="flex min-h-0 min-w-0 flex-1 flex-col">
          <ChatMessages
            :messages="messages"
            :loading="loading"
            :streaming-message-id="streamingMessageId"
            :pending-reply="awaitingAssistantReply && !streamingMessageId"
          />
          <ChatComposer
            :cores="cores"
            :core-code="currentCoreCode"
            :disabled="composerDisabled"
            :sending="busy"
            @core-change="handleCoreChange"
            @send="handleSend"
          />
        </div>

        <DraftPlanWorkspace
          ref="draftWorkspaceRef"
          :thread-id="activeThread.id"
          :wizard-phase="activeThread.wizardPhase"
          :messages="messages"
          :cores="cores"
          :initial-draft-id="resumeDraftId"
          @draft-updated="handleDraftUpdated"
          @plan-confirmed="handlePlanConfirmed"
          @workspace-ready-change="handleWorkspaceReadyChange"
        />
      </div>
    </template>

    <CreateTaskProjectDialog
      :open="createProjectDialogOpen"
      :projects="workspace.projects.value"
      :loading="pickingProject"
      @close="closeCreateProjectDialog"
      @select-project="handleSelectProject"
      @add-project="handleAddProject"
    />
  </div>
</template>
