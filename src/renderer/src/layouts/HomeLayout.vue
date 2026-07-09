<script setup lang="ts">
import { provide } from 'vue'
import { RouterView } from 'vue-router'
import AddLocalFolderDialog from '@renderer/components/home/AddLocalFolderDialog.vue'
import HomeSidebar from '@renderer/components/home/HomeSidebar.vue'
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
</script>

<template>
  <div class="flex h-full overflow-hidden bg-background">
    <HomeSidebar />
    <main class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <RouterView />
    </main>
    <AddLocalFolderDialog />
  </div>
</template>
