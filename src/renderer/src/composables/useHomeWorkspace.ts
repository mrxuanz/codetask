import { inject, onMounted, onScopeDispose, provide, ref, watch, type InjectionKey, type Ref } from 'vue'
import { createProject, deleteProject, fetchProjects, type Project } from '@renderer/api/projects'
import {
  createThread,
  deleteThread,
  fetchThreads,
  renameThread,
  type Thread
} from '@renderer/api/threads'
import type { JobEventHub } from '@renderer/composables/useJobEventHub'
import { threadTopic } from '@shared/contracts/job-event-hub'
import { getPreferredCoreCode } from '@renderer/lib/preferredCore'
import { workspaceRootsMatch } from '@renderer/lib/workspace'

export type HomeProject = Pick<Project, 'id' | 'title' | 'workspaceRoot' | 'updatedAt'>
export type HomeThread = Thread
export type ThreadKind = NonNullable<Thread['threadKind']>

export const THREAD_KIND_CHAT: ThreadKind = 'chat'
export const THREAD_KIND_CREATE_TASK: ThreadKind = 'create_task'

export function isChatThread(thread: HomeThread): boolean {
  return (thread.threadKind ?? THREAD_KIND_CHAT) === THREAD_KIND_CHAT
}

export function isCreateTaskThread(thread: HomeThread): boolean {
  return thread.threadKind === THREAD_KIND_CREATE_TASK
}

export interface HomeWorkspaceContext {
  projects: Ref<HomeProject[]>
  threads: Ref<HomeThread[]>
  activeProjectId: Ref<string | null>
  activeThreadId: Ref<string | null>
  expandedProjectIds: Ref<Record<string, boolean>>
  loading: Ref<boolean>
  addProjectOpen: Ref<boolean>
  setActiveProjectId: (id: string) => void
  setActiveThreadId: (id: string | null) => void
  toggleProjectExpanded: (id: string) => void
  setAddProjectOpen: (open: boolean) => void
  loadWorkspace: () => Promise<void>
  loadError: Ref<string | null>
  retryLoadWorkspace: () => Promise<void>
  addLocalProject: (
    workspaceRoot: string,
    options?: { threadKind?: ThreadKind }
  ) => Promise<HomeProject>
  createNewThread: (projectId: string, threadKind?: ThreadKind) => Promise<HomeThread>
  removeProject: (projectId: string) => Promise<void>
  removeThread: (threadId: string) => Promise<void>
  renameThreadTitle: (threadId: string, title: string) => Promise<HomeThread>
  syncThread: (thread: HomeThread) => void
  patchThreadRuntime: (
    threadId: string,
    patch: Pick<
      HomeThread,
      'runtimeStatus' | 'runtimeSessionId' | 'lastError' | 'lastUsedAt' | 'coreCode' | 'updatedAt'
    >
  ) => void
}

const HomeWorkspaceKey: InjectionKey<HomeWorkspaceContext> = Symbol('homeWorkspace')

function mapProject(project: Project): HomeProject {
  return {
    id: project.id,
    title: project.title,
    workspaceRoot: project.workspaceRoot,
    updatedAt: project.updatedAt
  }
}

function pickLatestThread(threads: HomeThread[], projectId: string): HomeThread | null {
  return threads.find((thread) => thread.projectId === projectId && isChatThread(thread)) ?? null
}

function findProjectByWorkspaceRoot(
  projectList: HomeProject[],
  workspaceRoot: string
): HomeProject | null {
  return projectList.find((item) => workspaceRootsMatch(item.workspaceRoot, workspaceRoot)) ?? null
}

function createThreadInput(): { coreCode?: string } {
  const coreCode = getPreferredCoreCode()
  return coreCode ? { coreCode } : {}
}

export function provideHomeWorkspace(hub: JobEventHub): HomeWorkspaceContext {
  const projects = ref<HomeProject[]>([])
  const threads = ref<HomeThread[]>([])
  const activeProjectId = ref<string | null>(null)
  const activeThreadId = ref<string | null>(null)
  const expandedProjectIds = ref<Record<string, boolean>>({})
  const loading = ref(false)
  const loadError = ref<string | null>(null)
  const addProjectOpen = ref(false)

  function setActiveProjectId(id: string): void {
    const latest = pickLatestThread(threads.value, id)
    activeProjectId.value = id
    activeThreadId.value = latest?.id ?? null
  }

  function setActiveThreadId(id: string | null): void {
    if (!id) {
      activeThreadId.value = null
      return
    }
    const thread = threads.value.find((item) => item.id === id)
    activeThreadId.value = id
    if (thread) {
      activeProjectId.value = thread.projectId
      expandedProjectIds.value = { ...expandedProjectIds.value, [thread.projectId]: true }
    }
  }

  function toggleProjectExpanded(id: string): void {
    expandedProjectIds.value[id] = !(expandedProjectIds.value[id] ?? true)
  }

  function setAddProjectOpen(open: boolean): void {
    addProjectOpen.value = open
  }

  function syncThread(thread: HomeThread): void {
    threads.value = threads.value.map((item) => (item.id === thread.id ? thread : item))
  }

  function patchThreadRuntime(
    threadId: string,
    patch: Pick<
      HomeThread,
      'runtimeStatus' | 'runtimeSessionId' | 'lastError' | 'lastUsedAt' | 'coreCode' | 'updatedAt'
    >
  ): void {
    threads.value = threads.value.map((item) =>
      item.id === threadId ? { ...item, ...patch } : item
    )
  }

  async function loadWorkspace(): Promise<void> {
    loading.value = true
    loadError.value = null
    try {
      const [projectsRes, threadsRes] = await Promise.all([fetchProjects(), fetchThreads()])
      const nextProjects = projectsRes.data.map(mapProject)
      const nextThreads = threadsRes.data

      const nextExpanded = { ...expandedProjectIds.value }
      for (const project of nextProjects) {
        if (nextExpanded[project.id] === undefined) {
          nextExpanded[project.id] = true
        }
      }
      expandedProjectIds.value = nextExpanded
      projects.value = nextProjects
      threads.value = nextThreads

      const keptProjectId =
        activeProjectId.value && nextProjects.some((p) => p.id === activeProjectId.value)
          ? activeProjectId.value
          : (nextProjects[0]?.id ?? null)
      activeProjectId.value = keptProjectId

      activeThreadId.value =
        activeThreadId.value && nextThreads.some((t) => t.id === activeThreadId.value)
          ? activeThreadId.value
          : keptProjectId
            ? (pickLatestThread(nextThreads, keptProjectId)?.id ?? null)
            : null
    } catch (err) {
      loadError.value =
        err instanceof Error ? err.message : 'workspace.load_failed'
    } finally {
      loading.value = false
    }
  }

  async function retryLoadWorkspace(): Promise<void> {
    await loadWorkspace()
  }

  async function addLocalProject(
    workspaceRoot: string,
    options?: { threadKind?: ThreadKind }
  ): Promise<HomeProject> {
    const threadKind = options?.threadKind ?? THREAD_KIND_CHAT
    const existing = findProjectByWorkspaceRoot(projects.value, workspaceRoot)
    if (existing) {
      const thread = await createNewThread(existing.id, threadKind)
      activeProjectId.value = existing.id
      activeThreadId.value = thread.id
      addProjectOpen.value = false
      return existing
    }

    const res = await createProject({ workspaceRoot, createIfMissing: true })
    const project = mapProject(res.data)
    const threadRes = await createThread(project.id, { ...createThreadInput(), threadKind })
    const thread = threadRes.data

    projects.value = [project, ...projects.value.filter((item) => item.id !== project.id)]
    threads.value = [thread, ...threads.value.filter((item) => item.id !== thread.id)]
    activeProjectId.value = project.id
    activeThreadId.value = thread.id
    expandedProjectIds.value = { ...expandedProjectIds.value, [project.id]: true }
    addProjectOpen.value = false

    return project
  }

  async function createNewThread(
    projectId: string,
    threadKind: ThreadKind = THREAD_KIND_CHAT
  ): Promise<HomeThread> {
    const res = await createThread(projectId, { ...createThreadInput(), threadKind })
    const thread = res.data
    threads.value = [thread, ...threads.value.filter((item) => item.id !== thread.id)]
    activeProjectId.value = projectId
    activeThreadId.value = thread.id
    expandedProjectIds.value = { ...expandedProjectIds.value, [projectId]: true }
    return thread
  }

  async function removeProject(projectId: string): Promise<void> {
    await deleteProject(projectId)
    const removedThreadIds = new Set(
      threads.value.filter((item) => item.projectId === projectId).map((item) => item.id)
    )
    projects.value = projects.value.filter((item) => item.id !== projectId)
    threads.value = threads.value.filter((item) => item.projectId !== projectId)
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { [projectId]: _removed, ...restExpanded } = expandedProjectIds.value
    expandedProjectIds.value = restExpanded

    if (activeProjectId.value === projectId) {
      activeProjectId.value = projects.value[0]?.id ?? null
      activeThreadId.value = activeProjectId.value
        ? (threads.value.find(
            (item) => item.projectId === activeProjectId.value && isChatThread(item)
          )?.id ?? null)
        : null
    } else if (activeThreadId.value && removedThreadIds.has(activeThreadId.value)) {
      activeThreadId.value = activeProjectId.value
        ? (threads.value.find(
            (item) => item.projectId === activeProjectId.value && isChatThread(item)
          )?.id ?? null)
        : null
    }
  }

  async function removeThread(threadId: string): Promise<void> {
    const existing = threads.value.find((item) => item.id === threadId)
    if (!existing) return
    await deleteThread(threadId)
    threads.value = threads.value.filter((item) => item.id !== threadId)
    if (activeThreadId.value === threadId) {
      activeThreadId.value =
        threads.value.find((item) => item.projectId === existing.projectId && isChatThread(item))
          ?.id ?? null
    }
  }

  async function renameThreadTitle(threadId: string, title: string): Promise<HomeThread> {
    const res = await renameThread(threadId, title)
    const thread = res.data
    threads.value = threads.value.map((item) => (item.id === threadId ? thread : item))
    return thread
  }

  let threadHubRelease: (() => void) | null = null

  watch(
    activeThreadId,
    (threadId) => {
      threadHubRelease?.()
      threadHubRelease = null
      if (!threadId) return
      threadHubRelease = hub.watchTopic(threadTopic(threadId), (envelope) => {
        if (envelope.event === 'thread_updated' || envelope.event === 'thread_snapshot') {
          syncThread(envelope.data.thread)
        }
      })
    },
    { immediate: true }
  )

  onScopeDispose(() => {
    threadHubRelease?.()
    threadHubRelease = null
  })

  const ctx: HomeWorkspaceContext = {
    projects,
    threads,
    activeProjectId,
    activeThreadId,
    expandedProjectIds,
    loading,
    loadError,
    addProjectOpen,
    setActiveProjectId,
    setActiveThreadId,
    toggleProjectExpanded,
    setAddProjectOpen,
    loadWorkspace,
    retryLoadWorkspace,
    addLocalProject,
    createNewThread,
    removeProject,
    removeThread,
    renameThreadTitle,
    syncThread,
    patchThreadRuntime
  }

  provide(HomeWorkspaceKey, ctx)
  onMounted(() => {
    void loadWorkspace()
  })
  return ctx
}

export function useHomeWorkspace(): HomeWorkspaceContext {
  const ctx = inject(HomeWorkspaceKey)
  if (!ctx) {
    throw new Error('useHomeWorkspace must be used within HomeLayout')
  }
  return ctx
}

export function threadsForProject(threads: HomeThread[], projectId: string): HomeThread[] {
  return threads
    .filter((thread) => thread.projectId === projectId && isChatThread(thread))
    .sort((a, b) => b.updatedAt - a.updatedAt)
}
