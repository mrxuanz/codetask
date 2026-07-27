<script setup lang="ts">
import { computed, ref, type Component } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { Folder, ListTodo, MessageSquare, Plus, Settings } from 'lucide-vue-next'
import type { SupportedCoreCode } from '@shared/providers/codes'
import Button from '@renderer/components/ui/Button.vue'
import Dialog from '@renderer/components/ui/Dialog.vue'
import ErrorAlert from '@renderer/components/ui/ErrorAlert.vue'
import LanguageSwitcher from '@renderer/components/LanguageSwitcher.vue'
import {
  threadsForWorkspace,
  useHomeWorkspace
} from '@renderer/composables/useHomeWorkspace'
import { useBootstrap } from '@renderer/composables/useBootstrap'
import { translateApiError } from '@renderer/i18n/translateApiError'

defineProps<{ mobileOpen?: boolean }>()
const emit = defineEmits<{ close: [] }>()

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const workspace = useHomeWorkspace()
const { data } = useBootstrap()
const createForWorkspace = ref<string | null>(null)
const selectedProvider = ref<SupportedCoreCode>('codex')
const acting = ref(false)
const error = ref<string | null>(null)

const navItems: Array<{
  label: () => string
  to: string
  icon: Component
  active: (path: string) => boolean
}> = [
  {
    label: () => t('conversation.nav.chat'),
    to: '/home',
    icon: MessageSquare,
    active: (path) => path === '/home' || path === '/home/'
  },
  {
    label: () => t('conversation.nav.drafts'),
    to: '/home/create',
    icon: Plus,
    active: (path) => path.startsWith('/home/create')
  },
  {
    label: () => t('conversation.nav.jobs'),
    to: '/home/tasks',
    icon: ListTodo,
    active: (path) => path.startsWith('/home/tasks')
  },
  {
    label: () => t('conversation.nav.settings'),
    to: '/home/settings',
    icon: Settings,
    active: (path) => path.startsWith('/home/settings')
  }
]

const selectableProviders = computed(() =>
  workspace.providers.value.filter((provider) => provider.installed && provider.authenticated)
)

function openCreateThread(workspaceId: string): void {
  createForWorkspace.value = workspaceId
  selectedProvider.value =
    selectableProviders.value.find((provider) => provider.code === selectedProvider.value)?.code ??
    selectableProviders.value[0]?.code ??
    'codex'
  error.value = null
}

async function createThread(): Promise<void> {
  const workspaceId = createForWorkspace.value
  if (!workspaceId || acting.value) return
  acting.value = true
  error.value = null
  try {
    await workspace.createThread(workspaceId, selectedProvider.value)
    createForWorkspace.value = null
    await router.push('/home')
    emit('close')
  } catch (cause) {
    error.value = translateApiError(cause instanceof Error ? cause.message : String(cause), t)
  } finally {
    acting.value = false
  }
}

async function openThread(id: string): Promise<void> {
  workspace.selectThread(id)
  if (route.path !== '/home') await router.push('/home')
  emit('close')
}

async function removeThread(id: string, title: string): Promise<void> {
  if (!window.confirm(`${t('common.delete')} “${title}”?`)) return
  await workspace.removeThread(id)
}

async function renameThread(id: string, currentTitle: string): Promise<void> {
  const next = window.prompt(t('conversation.threadTitle'), currentTitle)?.trim()
  if (next && next !== currentTitle) await workspace.renameThread(id, next)
}
</script>

<template>
  <aside
    class="fixed inset-y-0 left-0 z-50 flex w-72 shrink-0 -translate-x-full flex-col border-r border-border bg-card transition-transform md:static md:translate-x-0"
    :class="mobileOpen ? 'translate-x-0' : ''"
  >
    <div class="flex h-14 items-center justify-between border-b border-border px-4">
      <RouterLink to="/home" class="font-semibold tracking-tight" @click="emit('close')">
        CodeTask
      </RouterLink>
      <LanguageSwitcher />
    </div>

    <nav class="space-y-1 border-b border-border p-2">
      <RouterLink
        v-for="item in navItems"
        :key="item.to"
        :to="item.to"
        class="flex items-center gap-2 rounded-md px-3 py-2 text-sm"
        :class="
          item.active(route.path)
            ? 'bg-primary text-primary-foreground'
            : 'text-muted-foreground hover:bg-muted hover:text-foreground'
        "
        @click="emit('close')"
      >
        <component :is="item.icon" class="size-4" />
        {{ item.label() }}
      </RouterLink>
    </nav>

    <div class="flex items-center justify-between px-4 pb-2 pt-4">
      <span class="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {{ t('conversation.workspaces') }}
      </span>
      <Button size="sm" variant="ghost" class="size-8 px-0" @click="workspace.folderDialogOpen.value = true">
        <Plus class="size-4" />
      </Button>
    </div>

    <div class="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
      <p v-if="workspace.error.value" class="m-2 rounded-md bg-destructive/10 p-2 text-xs text-destructive">
        {{ workspace.error.value }}
      </p>
      <div v-for="project in workspace.workspaces.value" :key="project.id" class="mb-1">
        <div
          class="group flex items-center gap-1 rounded-md px-2 py-1.5"
          :class="workspace.selectedWorkspaceId.value === project.id ? 'bg-muted' : 'hover:bg-muted/70'"
        >
          <button
            type="button"
            class="flex min-w-0 flex-1 items-center gap-2 text-left text-sm"
            @click="workspace.toggleWorkspace(project.id)"
          >
            <span class="w-3 text-xs text-muted-foreground">
              {{ workspace.expandedWorkspaceIds[project.id] ?? true ? '⌄' : '›' }}
            </span>
            <Folder class="size-4 shrink-0" />
            <span class="truncate">{{ project.title }}</span>
          </button>
          <Button size="sm" variant="ghost" class="size-7 px-0 opacity-0 group-hover:opacity-100" @click="openCreateThread(project.id)">
            <Plus class="size-3.5" />
          </Button>
        </div>
        <div v-if="workspace.expandedWorkspaceIds[project.id] ?? true" class="ml-5 border-l border-border pl-2">
          <div
            v-for="thread in threadsForWorkspace(workspace.threads.value, project.id)"
            :key="thread.id"
            class="group flex items-center rounded-md"
            :class="workspace.selectedThreadId.value === thread.id ? 'bg-primary/10 text-primary' : 'hover:bg-muted'"
          >
            <button
              type="button"
              class="min-w-0 flex-1 truncate px-2 py-1.5 text-left text-xs"
              @click="openThread(thread.id)"
              @dblclick="renameThread(thread.id, thread.title)"
            >
              {{ thread.title }}
            </button>
            <span class="mr-1 rounded bg-muted px-1 text-[9px] uppercase text-muted-foreground">
              {{ thread.provider }}
            </span>
            <button
              type="button"
              class="mr-1 text-xs text-muted-foreground opacity-0 group-hover:opacity-100"
              @click="removeThread(thread.id, thread.title)"
            >
              ×
            </button>
          </div>
          <p
            v-if="threadsForWorkspace(workspace.threads.value, project.id).length === 0"
            class="px-2 py-2 text-[11px] text-muted-foreground"
          >
            {{ t('conversation.noThreads') }}
          </p>
        </div>
      </div>
    </div>

    <div class="border-t border-border px-4 py-3 text-xs text-muted-foreground">
      <p class="truncate">{{ data?.username }}</p>
    </div>
  </aside>

  <Dialog :open="createForWorkspace !== null" @close="createForWorkspace = null">
    <div class="border-b border-border px-5 py-4">
      <h2 class="font-semibold">{{ t('conversation.chooseProvider') }}</h2>
      <p class="mt-1 text-sm text-muted-foreground">
        {{ t('conversation.chooseProviderDescription') }}
      </p>
    </div>
    <div class="space-y-2 p-5">
      <ErrorAlert v-if="error" :message="error" />
      <label
        v-for="provider in workspace.providers.value"
        :key="provider.code"
        class="flex cursor-pointer items-start gap-3 rounded-lg border p-3"
        :class="
          selectedProvider === provider.code
            ? 'border-primary bg-primary/5'
            : 'border-border'
        "
      >
        <input
          v-model="selectedProvider"
          type="radio"
          :value="provider.code"
          :disabled="!provider.installed || !provider.authenticated"
          class="mt-1"
        />
        <span class="min-w-0 flex-1">
          <span class="flex items-center justify-between gap-3">
            <strong class="text-sm">{{ provider.label }}</strong>
            <span class="text-[10px] uppercase text-muted-foreground">{{ provider.protocol }}</span>
          </span>
          <span class="mt-1 block text-xs text-muted-foreground">{{ provider.message }}</span>
          <code v-if="!provider.authenticated" class="mt-2 block text-[11px]">
            {{ provider.loginCommand }}
          </code>
        </span>
      </label>
    </div>
    <div class="flex justify-end gap-2 border-t border-border p-4">
      <Button variant="outline" @click="createForWorkspace = null">{{ t('common.cancel') }}</Button>
      <Button :disabled="acting || selectableProviders.length === 0" @click="createThread">
        {{ t('conversation.newThread') }}
      </Button>
    </div>
  </Dialog>
</template>
