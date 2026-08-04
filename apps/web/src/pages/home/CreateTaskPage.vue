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
import { useHomeWorkspace } from '@renderer/composables/useHomeWorkspace'
import { getPreferredProviderCode } from '@renderer/lib/preferredCore'

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
const compactPane = ref<'chat' | 'draft'>('chat')
/** Mirrors DraftPlanWorkspace first-load gate (reactive via workspaceReadyChange). */
const workspaceReady = ref(false)

const messages = computed(() => chat.messages.value)
const cores = computed(() => chat.cores.value)
const conversationCores = computed(() =>
  cores.value.filter((core) => core.readOnlyCapable !== false)
)
const activeProviderCode = computed(() => chat.activeProviderCode.value)
const loading = computed(() => chat.loading.value)
const providerSwitching = computed(() => chat.providerSwitching.value)
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

const currentProviderCode = computed(() => {
  const fromThread = activeProviderCode.value ?? activeThread.value?.providerCode
  if (fromThread && conversationCores.value.some((core) => core.code === fromThread)) {
    return fromThread
  }
  const preferred = getPreferredProviderCode()
  if (
    preferred &&
    conversationCores.value.some((core) => core.code === preferred && core.available)
  ) {
    return preferred
  }
  return (
    conversationCores.value.find((core) => core.available)?.code ??
    conversationCores.value[0]?.code ??
    ''
  )
})

const selectedProvider = computed(() =>
  conversationCores.value.find((core) => core.code === currentProviderCode.value)
)
const providerUnavailable = computed(
  () => cores.value.length > 0 && (!selectedProvider.value || !selectedProvider.value.available)
)
const busy = computed(
  () => sending.value || runtimeStatus.value === 'running' || providerSwitching.value
)

/** Block send until the right-hand workspace finishes its first load for this thread. */
const workspaceNotReady = computed(
  () => phase.value === 'workspace' && Boolean(activeThread.value) && !workspaceReady.value
)

const composerDisabled = computed(
  () =>
    loading.value || providerSwitching.value || providerUnavailable.value || workspaceNotReady.value
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
  () => {
    const exposed = draftWorkspaceRef.value as {
      selectedDraftId?: { value?: string | null } | string | null
    } | null
    if (!exposed?.selectedDraftId) return null
    const id = exposed.selectedDraftId
    return typeof id === 'object' && id && 'value' in id ? id.value : id
  },
  (draftId) => {
    if (phase.value === 'workspace' && draftId) compactPane.value = 'draft'
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
  resumeDraftId.value = null
  compactPane.value = 'chat'
  completedContext.value = null
  phase.value = 'list'
  workspace.setActiveThreadId(null)
  void nextTick().then(() => {
    void draftListRef.value?.reload()
  })
}

function openCompleted(entry: DraftListEntry): void {
  const jobId = entry.jobId ?? entry.linkedPlanId ?? entry.plan?.id
  if (!jobId) return
  completedContext.value = {
    threadId: entry.threadId ?? '',
    draftMessageId: entry.draftId || entry.messageId,
    jobId,
    title: entry.title
  }
  phase.value = 'completed'
}

function resolveCompletedJobId(entry: DraftListEntry): string | null {
  return entry.jobId ?? entry.linkedPlanId ?? entry.plan?.id ?? null
}

function handleContinueDraft(entry: DraftListEntry): void {
  // setActiveProjectId also selects the project's latest conversation when present.
  workspace.setActiveProjectId(entry.projectId)
  if (entry.threadId?.trim()) {
    workspace.setActiveThreadId(entry.threadId)
  }
  resumeDraftId.value = entry.draftId || entry.messageId
  compactPane.value = 'draft'
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
  compactPane.value = 'chat'
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
    await workspace.createNewThread(projectId)
    resumeDraftId.value = null
    compactPane.value = 'chat'
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
    await workspace.addLocalProject(workspaceRoot)
    resumeDraftId.value = null
    compactPane.value = 'chat'
    completedContext.value = null
    createProjectDialogOpen.value = false
    phase.value = 'workspace'
  } finally {
    pickingProject.value = false
  }
}

async function handleCoreChange(code: string): Promise<void> {
  const thread = activeThread.value
  if (!thread || code === currentProviderCode.value) return
  const updated = await chat.setProviderCode(thread.id, code)
  if (updated) workspace.syncThread(updated)
}

async function handleSend(payload: { message: string; files: File[] }): Promise<void> {
  if (composerDisabled.value) return
  const updated = await chat.sendMessage({
    message: payload.message,
    files: payload.files
  })
  if (updated) workspace.syncThread(updated)
}

function handleDraftUpdated(
  _draftId: string,
  _draft: import('@renderer/lib/draftForm').TaskLaunchDraftPayload
): void {
  // Draft state lives in Design module / draft workspace — not chat messages.
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
      class="flex min-h-12 shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-1 sm:px-4"
    >
      <div class="flex min-w-0 items-center gap-2">
        <h1 class="truncate text-sm font-medium">{{ t('workspace.nav.createTask') }}</h1>
        <span
          v-if="activeProject && (phase === 'workspace' || phase === 'completed')"
          class="hidden shrink-0 rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground sm:inline"
        >
          {{ activeProject.title }}
        </span>
        <span
          v-if="phase === 'workspace' && providerSwitching"
          class="text-xs text-muted-foreground"
        >
          {{ t('workspace.switchingCore') }}
        </span>
        <span v-else-if="phase === 'workspace' && busy" class="text-xs text-muted-foreground">
          {{ t('workspace.running') }}
        </span>
        <span
          v-else-if="phase === 'workspace' && runtimeStatus === 'error' && !busy"
          class="text-xs text-destructive"
        >
          {{ t('workspace.lastRunFailed') }}
        </span>
      </div>
      <div
        v-if="phase === 'workspace' || phase === 'completed'"
        class="flex shrink-0 items-center gap-1 sm:gap-2"
      >
        <template v-if="phase === 'workspace'">
          <Button
            type="button"
            :variant="compactPane === 'chat' ? 'outline' : 'ghost'"
            size="sm"
            class="px-2 xl:hidden"
            @click="compactPane = 'chat'"
          >
            {{ t('workspace.nav.chat') }}
          </Button>
          <Button
            type="button"
            :variant="compactPane === 'draft' ? 'outline' : 'ghost'"
            size="sm"
            class="px-2 xl:hidden"
            @click="compactPane = 'draft'"
          >
            {{ t('workspace.draftPanel.title') }}
          </Button>
        </template>
        <Button type="button" variant="outline" size="sm" @click="goToList">
          <span class="hidden sm:inline">{{ t('workspace.create.backToDraftList') }}</span>
          <span class="sm:hidden">{{ t('workspace.tasks.backToList') }}</span>
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

      <div v-if="providerUnavailable" class="shrink-0 px-4 pt-3 sm:px-6">
        <ErrorAlert :message="selectedProvider?.reason ?? t('workspace.providerUnavailable')" />
      </div>

      <div class="flex min-h-0 min-w-0 flex-1">
        <div
          class="flex min-h-0 min-w-0 flex-1 flex-col"
          :class="compactPane === 'draft' ? 'max-xl:hidden' : ''"
        >
          <ChatMessages
            :messages="messages"
            :loading="loading"
            :streaming-message-id="streamingMessageId"
            :pending-reply="awaitingAssistantReply && !streamingMessageId"
          />
          <ChatComposer
            :cores="conversationCores"
            :provider-code="currentProviderCode"
            require-read-only-core
            :disabled="composerDisabled"
            :sending="busy"
            @core-change="handleCoreChange"
            @send="handleSend"
          />
        </div>

        <DraftPlanWorkspace
          ref="draftWorkspaceRef"
          :thread-id="activeThread.id"
          :messages="messages"
          :cores="cores"
          :initial-draft-id="resumeDraftId"
          :class="compactPane === 'chat' ? 'max-xl:hidden' : ''"
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
