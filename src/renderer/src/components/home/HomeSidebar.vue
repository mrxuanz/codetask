<script setup lang="ts">
import { computed, ref, type Component } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { ChevronRight, Folder, ListTodo, MessageSquare, Plus, Settings } from 'lucide-vue-next'
import ThreadSidebarItem from '@renderer/components/home/ThreadSidebarItem.vue'
import Button from '@renderer/components/ui/Button.vue'
import Tooltip from '@renderer/components/ui/Tooltip.vue'
import ConfirmDialog from '@renderer/components/ui/ConfirmDialog.vue'
import ContextMenu from '@renderer/components/ui/ContextMenu.vue'
import RenameDialog from '@renderer/components/ui/RenameDialog.vue'
import {
  threadsForProject,
  isCreateTaskThread,
  useHomeWorkspace
} from '@renderer/composables/useHomeWorkspace'
import { cn } from '@renderer/lib/utils'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()

const workspace = useHomeWorkspace()

const projects = computed(() => workspace.projects.value)
const threads = computed(() => workspace.threads.value)
const activeProjectId = computed(() => workspace.activeProjectId.value)
const activeThreadId = computed(() => workspace.activeThreadId.value)

const navItems = computed(() => [
  {
    labelKey: 'workspace.nav.chat',
    to: '/home',
    match: (path: string) => path === '/home' || path === '/home/',
    icon: MessageSquare as Component
  },
  {
    labelKey: 'workspace.nav.createTask',
    to: '/home/create',
    match: (path: string) => path.startsWith('/home/create'),
    icon: Plus as Component
  },
  {
    labelKey: 'workspace.nav.tasks',
    to: '/home/tasks',
    match: (path: string) => path.startsWith('/home/tasks'),
    icon: ListTodo as Component
  },
  {
    labelKey: 'workspace.nav.settings',
    to: '/home/settings',
    match: (path: string) => path.startsWith('/home/settings'),
    icon: Settings as Component
  }
])

function isExpanded(projectId: string): boolean {
  return workspace.expandedProjectIds.value[projectId] ?? true
}

type ContextTarget =
  | { kind: 'project'; id: string; title: string }
  | { kind: 'thread'; id: string; title: string }

const contextMenu = ref<{ x: number; y: number; target: ContextTarget } | null>(null)
const confirmDelete = ref<ContextTarget | null>(null)
const renameTarget = ref<{ id: string; title: string } | null>(null)
const actionLoading = ref(false)
const actionError = ref<string | null>(null)

const contextMenuItems = computed(() => {
  if (!contextMenu.value) return []
  if (contextMenu.value.target.kind === 'project') {
    return [{ id: 'delete', label: t('workspace.sidebar.removeProject'), destructive: true }]
  }
  return [
    { id: 'rename', label: t('workspace.sidebar.rename') },
    { id: 'delete', label: t('workspace.sidebar.deleteThread'), destructive: true }
  ]
})

function openProjectContextMenu(event: MouseEvent, project: { id: string; title: string }): void {
  event.preventDefault()
  event.stopPropagation()
  contextMenu.value = {
    x: event.clientX,
    y: event.clientY,
    target: { kind: 'project', id: project.id, title: project.title }
  }
}

function openThreadContextMenu(event: MouseEvent, thread: { id: string; title: string }): void {
  event.preventDefault()
  event.stopPropagation()
  const title = thread.title || t('workspace.newThread')
  contextMenu.value = {
    x: event.clientX,
    y: event.clientY,
    target: { kind: 'thread', id: thread.id, title }
  }
}

function closeContextMenu(): void {
  contextMenu.value = null
}

async function handleCreateThread(projectId: string): Promise<void> {
  await workspace.createNewThread(projectId)
  if (route.path !== '/home' && route.path !== '/home/') {
    await router.push('/home')
  }
}

function onContextMenuSelect(actionId: string): void {
  const target = contextMenu.value?.target
  closeContextMenu()
  if (!target) return
  if (actionId === 'delete') {
    confirmDelete.value = target
    return
  }
  if (actionId === 'rename' && target.kind === 'thread') {
    renameTarget.value = { id: target.id, title: target.title }
  }
}

async function handleConfirmDelete(): Promise<void> {
  const target = confirmDelete.value
  if (!target) return
  actionLoading.value = true
  actionError.value = null
  try {
    if (target.kind === 'project') {
      await workspace.removeProject(target.id)
      if (route.path !== '/home' && route.path !== '/home/create') await router.push('/home')
    } else {
      await workspace.removeThread(target.id)
      if (activeThreadId.value === null && route.path === '/home') {
        // stay on home
      } else if (target.id === activeThreadId.value) {
        await router.push('/home')
      }
    }
    confirmDelete.value = null
  } catch (err) {
    actionError.value = err instanceof Error ? err.message : String(err)
  } finally {
    actionLoading.value = false
  }
}

async function handleRenameConfirm(title: string): Promise<void> {
  const target = renameTarget.value
  if (!target) return
  actionLoading.value = true
  actionError.value = null
  try {
    await workspace.renameThreadTitle(target.id, title)
    renameTarget.value = null
  } catch (err) {
    actionError.value = err instanceof Error ? err.message : String(err)
  } finally {
    actionLoading.value = false
  }
}

const confirmDeleteTitle = computed(() =>
  confirmDelete.value?.kind === 'project'
    ? t('workspace.sidebar.confirmRemoveProjectTitle')
    : t('workspace.sidebar.confirmDeleteThreadTitle')
)

const confirmDeleteMessage = computed(() => {
  const name = confirmDelete.value?.title ?? ''
  return confirmDelete.value?.kind === 'project'
    ? t('workspace.sidebar.confirmRemoveProjectMessage', { name })
    : t('workspace.sidebar.confirmDeleteThreadMessage', { name })
})
</script>

<template>
  <aside
    class="flex h-full min-h-0 w-72 shrink-0 flex-col overflow-hidden border-r border-border bg-muted/25"
  >
    <div class="border-b border-border px-3 py-3">
      <p class="px-2 text-[11px] font-semibold tracking-wide text-muted-foreground">
        {{ t('workspace.section.workspace') }}
      </p>
      <div class="mt-2 grid gap-1">
        <button
          v-for="item in navItems"
          :key="item.to"
          type="button"
          :class="
            cn(
              'flex h-9 items-center gap-2 rounded-md px-2.5 text-sm transition-colors',
              item.match(route.path)
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:bg-background/70 hover:text-foreground'
            )
          "
          @click="router.push(item.to)"
        >
          <component :is="item.icon" class="size-4 shrink-0" aria-hidden="true" />
          <span>{{ t(item.labelKey) }}</span>
        </button>
      </div>
    </div>

    <div class="flex items-center justify-between px-3 py-3">
      <span class="px-2 text-[11px] font-semibold tracking-wide text-muted-foreground">
        {{ t('workspace.section.projects') }}
      </span>
      <Tooltip :label="t('workspace.addProject')" side="left">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          class="size-8 px-0"
          :aria-label="t('workspace.addProject')"
          @click="workspace.setAddProjectOpen(true)"
        >
          <span class="text-lg leading-none">+</span>
        </Button>
      </Tooltip>
    </div>

    <div class="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
      <button
        v-if="projects.length === 0"
        type="button"
        class="w-full rounded-md px-2 py-2 text-left text-sm text-muted-foreground hover:bg-muted"
        @click="workspace.setAddProjectOpen(true)"
      >
        {{ t('workspace.addProjectHint') }}
      </button>

      <ul class="space-y-0.5">
        <li v-for="project in projects" :key="project.id">
          <div
            :class="
              cn(
                'relative flex items-center gap-1 rounded-md px-1 py-1',
                project.id === activeProjectId && !activeThreadId && 'bg-muted'
              )
            "
          >
            <button
              type="button"
              class="flex size-6 items-center justify-center rounded hover:bg-background"
              :aria-label="isExpanded(project.id) ? t('workspace.collapse') : t('workspace.expand')"
              @click="workspace.toggleProjectExpanded(project.id)"
            >
              <ChevronRight
                :class="
                  cn(
                    'size-4 text-muted-foreground transition-transform',
                    isExpanded(project.id) ? 'rotate-90' : 'rotate-0'
                  )
                "
                aria-hidden="true"
              />
            </button>
            <button
              type="button"
              class="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-1 pr-8 text-left text-sm hover:bg-background"
              @click="
                () => {
                  workspace.setActiveProjectId(project.id)
                  router.push('/home')
                }
              "
              @contextmenu="openProjectContextMenu($event, project)"
            >
              <Folder class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span class="truncate font-medium">{{ project.title }}</span>
            </button>

            <div class="absolute top-1/2 right-0.5 -translate-y-1/2">
              <Tooltip
                side="left"
                :label="t('workspace.newThreadInProject', { project: project.title })"
              >
                <button
                  type="button"
                  :aria-label="t('workspace.newThreadInProject', { project: project.title })"
                  class="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-background hover:text-foreground"
                  @click.stop="handleCreateThread(project.id)"
                >
                  <Plus class="size-4" aria-hidden="true" />
                </button>
              </Tooltip>
            </div>
          </div>

          <div
            v-if="isExpanded(project.id)"
            class="ml-7 space-y-0.5 border-l border-border/80 pl-2"
          >
            <div
              v-if="threadsForProject(threads, project.id).length === 0"
              class="px-2 py-1.5 text-[10px] text-muted-foreground/70"
            >
              {{ t('workspace.noThreads') }}
            </div>

            <ThreadSidebarItem
              v-for="thread in threadsForProject(threads, project.id)"
              :key="thread.id"
              :thread="thread"
              :active="thread.id === activeThreadId"
              @select="
                () => {
                  workspace.setActiveThreadId(thread.id)
                  router.push(isCreateTaskThread(thread) ? '/home/create' : '/home')
                }
              "
              @contextmenu="openThreadContextMenu($event, thread)"
            />
          </div>
        </li>
      </ul>
    </div>

    <ContextMenu
      :open="Boolean(contextMenu)"
      :x="contextMenu?.x ?? 0"
      :y="contextMenu?.y ?? 0"
      :items="contextMenuItems"
      @select="onContextMenuSelect"
      @close="closeContextMenu"
    />

    <ConfirmDialog
      :open="Boolean(confirmDelete)"
      :title="confirmDeleteTitle"
      :message="confirmDeleteMessage"
      :loading="actionLoading"
      @close="confirmDelete = null"
      @confirm="handleConfirmDelete"
    />

    <RenameDialog
      :open="Boolean(renameTarget)"
      :title="t('workspace.sidebar.renameThreadTitle')"
      :initial-value="renameTarget?.title"
      :loading="actionLoading"
      @close="renameTarget = null"
      @confirm="handleRenameConfirm"
    />

    <p v-if="actionError" class="px-3 pb-2 text-xs text-destructive">{{ actionError }}</p>
  </aside>
</template>
