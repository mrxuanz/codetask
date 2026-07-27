import {
  computed,
  inject,
  onMounted,
  provide,
  reactive,
  ref,
  type ComputedRef,
  type InjectionKey,
  type Ref
} from 'vue'
import type { SupportedCoreCode } from '@shared/providers/codes'
import {
  createConversationThread,
  createConversationWorkspace,
  deleteConversationThread,
  deleteConversationWorkspace,
  fetchConversationProviderStatuses,
  fetchConversationThreads,
  fetchConversationWorkspaces,
  updateConversationThread,
  type ConversationProviderStatus,
  type ConversationThread,
  type ConversationWorkspace
} from '@renderer/api/conversation'

export interface HomeWorkspaceContext {
  readonly workspaces: Ref<ConversationWorkspace[]>
  readonly threads: Ref<ConversationThread[]>
  readonly providers: Ref<ConversationProviderStatus[]>
  readonly selectedWorkspaceId: Ref<string | null>
  readonly selectedThreadId: Ref<string | null>
  readonly selectedWorkspace: ComputedRef<ConversationWorkspace | null>
  readonly selectedThread: ComputedRef<ConversationThread | null>
  readonly expandedWorkspaceIds: Record<string, boolean>
  readonly loading: Ref<boolean>
  readonly error: Ref<string | null>
  readonly folderDialogOpen: Ref<boolean>
  load(): Promise<void>
  selectWorkspace(id: string): void
  selectThread(id: string): void
  toggleWorkspace(id: string): void
  addWorkspace(path: string): Promise<ConversationWorkspace>
  removeWorkspace(id: string): Promise<void>
  createThread(workspaceId: string, provider: SupportedCoreCode): Promise<ConversationThread>
  renameThread(id: string, title: string): Promise<ConversationThread>
  switchThreadProvider(id: string, provider: SupportedCoreCode): Promise<ConversationThread>
  removeThread(id: string): Promise<void>
  refreshWorkspace(id: string): Promise<void>
}

const HomeWorkspaceKey: InjectionKey<HomeWorkspaceContext> = Symbol('HomeWorkspace')

function latestThread(threads: readonly ConversationThread[], workspaceId: string): ConversationThread | null {
  return (
    threads
      .filter((thread) => thread.workspaceId === workspaceId)
      .sort(
        (left, right) =>
          (right.lastMessageAtMs ?? right.createdAtMs) - (left.lastMessageAtMs ?? left.createdAtMs)
      )[0] ?? null
  )
}

export function provideHomeWorkspace(): HomeWorkspaceContext {
  const workspaces = ref<ConversationWorkspace[]>([])
  const threads = ref<ConversationThread[]>([])
  const providers = ref<ConversationProviderStatus[]>([])
  const selectedWorkspaceId = ref<string | null>(null)
  const selectedThreadId = ref<string | null>(null)
  const expandedWorkspaceIds = reactive<Record<string, boolean>>({})
  const loading = ref(true)
  const error = ref<string | null>(null)
  const folderDialogOpen = ref(false)

  const selectedWorkspace = computed(
    () => workspaces.value.find((workspace) => workspace.id === selectedWorkspaceId.value) ?? null
  )
  const selectedThread = computed(
    () => threads.value.find((thread) => thread.id === selectedThreadId.value) ?? null
  )

  function selectWorkspace(id: string): void {
    selectedWorkspaceId.value = id
    selectedThreadId.value = latestThread(threads.value, id)?.id ?? null
    expandedWorkspaceIds[id] = true
  }

  function selectThread(id: string): void {
    const thread = threads.value.find((candidate) => candidate.id === id)
    if (!thread) return
    selectedWorkspaceId.value = thread.workspaceId
    selectedThreadId.value = id
    expandedWorkspaceIds[thread.workspaceId] = true
  }

  function toggleWorkspace(id: string): void {
    expandedWorkspaceIds[id] = !(expandedWorkspaceIds[id] ?? true)
  }

  async function refreshWorkspace(id: string): Promise<void> {
    const next = (await fetchConversationThreads(id)).data
    threads.value = [
      ...threads.value.filter((thread) => thread.workspaceId !== id),
      ...next
    ]
  }

  async function load(): Promise<void> {
    loading.value = true
    error.value = null
    try {
      const [workspaceResult, providerResult] = await Promise.all([
        fetchConversationWorkspaces(),
        fetchConversationProviderStatuses()
      ])
      const nextWorkspaces = workspaceResult.data
      const threadGroups = await Promise.all(
        nextWorkspaces.map(async (workspace) => (await fetchConversationThreads(workspace.id)).data)
      )
      workspaces.value = nextWorkspaces
      threads.value = threadGroups.flat()
      providers.value = providerResult.data
      for (const workspace of nextWorkspaces) {
        if (expandedWorkspaceIds[workspace.id] === undefined) {
          expandedWorkspaceIds[workspace.id] = true
        }
      }
      const selectedStillExists = nextWorkspaces.some(
        (workspace) => workspace.id === selectedWorkspaceId.value
      )
      const workspaceId = selectedStillExists
        ? selectedWorkspaceId.value
        : (nextWorkspaces[0]?.id ?? null)
      if (workspaceId) {
        selectedWorkspaceId.value = workspaceId
        const threadStillExists = threads.value.some(
          (thread) =>
            thread.id === selectedThreadId.value && thread.workspaceId === selectedWorkspaceId.value
        )
        if (!threadStillExists) {
          selectedThreadId.value = latestThread(threads.value, workspaceId)?.id ?? null
        }
      } else {
        selectedWorkspaceId.value = null
        selectedThreadId.value = null
      }
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause)
    } finally {
      loading.value = false
    }
  }

  async function addWorkspace(path: string): Promise<ConversationWorkspace> {
    const created = (await createConversationWorkspace(path)).data
    workspaces.value = [created, ...workspaces.value]
    expandedWorkspaceIds[created.id] = true
    selectedWorkspaceId.value = created.id
    selectedThreadId.value = null
    return created
  }

  async function removeWorkspace(id: string): Promise<void> {
    await deleteConversationWorkspace(id)
    workspaces.value = workspaces.value.filter((workspace) => workspace.id !== id)
    threads.value = threads.value.filter((thread) => thread.workspaceId !== id)
    delete expandedWorkspaceIds[id]
    if (selectedWorkspaceId.value === id) {
      const next = workspaces.value[0]
      selectedWorkspaceId.value = next?.id ?? null
      selectedThreadId.value = next ? latestThread(threads.value, next.id)?.id ?? null : null
    }
  }

  async function createThread(
    workspaceId: string,
    provider: SupportedCoreCode
  ): Promise<ConversationThread> {
    const created = (await createConversationThread(workspaceId, provider)).data
    threads.value = [created, ...threads.value]
    selectedWorkspaceId.value = workspaceId
    selectedThreadId.value = created.id
    expandedWorkspaceIds[workspaceId] = true
    return created
  }

  async function renameThread(id: string, title: string): Promise<ConversationThread> {
    const updated = (await updateConversationThread(id, { title })).data
    threads.value = threads.value.map((thread) => (thread.id === id ? updated : thread))
    return updated
  }

  async function switchThreadProvider(
    id: string,
    provider: SupportedCoreCode
  ): Promise<ConversationThread> {
    const updated = (await updateConversationThread(id, { provider })).data
    threads.value = threads.value.map((thread) => (thread.id === id ? updated : thread))
    return updated
  }

  async function removeThread(id: string): Promise<void> {
    const removed = threads.value.find((thread) => thread.id === id)
    await deleteConversationThread(id)
    threads.value = threads.value.filter((thread) => thread.id !== id)
    if (selectedThreadId.value === id && removed) {
      selectedThreadId.value = latestThread(threads.value, removed.workspaceId)?.id ?? null
    }
  }

  const context: HomeWorkspaceContext = {
    workspaces,
    threads,
    providers,
    selectedWorkspaceId,
    selectedThreadId,
    selectedWorkspace,
    selectedThread,
    expandedWorkspaceIds,
    loading,
    error,
    folderDialogOpen,
    load,
    selectWorkspace,
    selectThread,
    toggleWorkspace,
    addWorkspace,
    removeWorkspace,
    createThread,
    renameThread,
    switchThreadProvider,
    removeThread,
    refreshWorkspace
  }
  provide(HomeWorkspaceKey, context)
  onMounted(() => void load())
  return context
}

export function useHomeWorkspace(): HomeWorkspaceContext {
  const context = inject(HomeWorkspaceKey)
  if (!context) throw new Error('useHomeWorkspace must be used inside HomeLayout')
  return context
}

export function threadsForWorkspace(
  threads: readonly ConversationThread[],
  workspaceId: string
): ConversationThread[] {
  return threads
    .filter((thread) => thread.workspaceId === workspaceId)
    .sort(
      (left, right) =>
        (right.lastMessageAtMs ?? right.createdAtMs) - (left.lastMessageAtMs ?? left.createdAtMs)
    )
}
