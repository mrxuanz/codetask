<script setup lang="ts">
import { computed, provide, ref, watch } from 'vue'
import { Menu } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'
import { RouterView, useRoute } from 'vue-router'
import AddLocalFolderDialog from '@renderer/components/home/AddLocalFolderDialog.vue'
import HomeSidebar from '@renderer/components/home/HomeSidebar.vue'
import Button from '@renderer/components/ui/Button.vue'
import { useHomeChat, HomeChatKey } from '@renderer/composables/useHomeChat'
import { provideHomeWorkspace } from '@renderer/composables/useHomeWorkspace'

import { provideJobEventHub } from '@renderer/composables/useJobEventHub'

const hub = provideJobEventHub()
const workspace = provideHomeWorkspace(hub)
const chat = useHomeChat(
  (thread) => workspace.syncThread(thread),
  (threadId, patch) => workspace.patchThreadRuntime(threadId, patch)
)
provide(HomeChatKey, chat)

const { t } = useI18n()
const route = useRoute()
const mobileSidebarOpen = ref(false)

const currentSection = computed(() => {
  if (route.path.startsWith('/home/create')) return t('workspace.nav.createTask')
  if (route.path.startsWith('/home/tasks')) return t('workspace.nav.tasks')
  if (route.path.startsWith('/home/settings')) return t('workspace.nav.settings')
  return t('workspace.nav.chat')
})

watch(
  () => route.fullPath,
  () => {
    mobileSidebarOpen.value = false
  }
)
</script>

<template>
  <div class="flex h-full min-w-0 flex-col overflow-hidden bg-background md:flex-row">
    <header
      class="flex h-12 shrink-0 items-center gap-2 border-b border-border bg-background px-3 md:hidden"
    >
      <Button
        type="button"
        variant="ghost"
        size="sm"
        class="size-9 px-0"
        :aria-label="t('workspace.section.workspace')"
        :aria-expanded="mobileSidebarOpen"
        @click="mobileSidebarOpen = true"
      >
        <Menu class="size-5" aria-hidden="true" />
      </Button>
      <span class="truncate text-sm font-semibold">{{ currentSection }}</span>
    </header>

    <button
      v-if="mobileSidebarOpen"
      type="button"
      class="fixed inset-0 z-40 bg-black/35 md:hidden"
      :aria-label="t('folderPicker.close')"
      @click="mobileSidebarOpen = false"
    />

    <HomeSidebar :mobile-open="mobileSidebarOpen" @close="mobileSidebarOpen = false" />
    <main class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <RouterView />
    </main>
    <AddLocalFolderDialog />
  </div>
</template>
