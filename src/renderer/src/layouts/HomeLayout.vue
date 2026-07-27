<script setup lang="ts">
import { ref, watch } from 'vue'
import { Menu } from 'lucide-vue-next'
import { RouterView, useRoute } from 'vue-router'
import Button from '@renderer/components/ui/Button.vue'
import HomeSidebar from '@renderer/components/home/HomeSidebar.vue'
import WorkspaceFolderDialog from '@renderer/components/home/WorkspaceFolderDialog.vue'
import { provideHomeWorkspace } from '@renderer/composables/useHomeWorkspace'

provideHomeWorkspace()
const route = useRoute()
const mobileOpen = ref(false)

watch(
  () => route.fullPath,
  () => {
    mobileOpen.value = false
  }
)
</script>

<template>
  <div class="flex h-full min-h-0 min-w-0 overflow-hidden bg-background">
    <button
      v-if="mobileOpen"
      type="button"
      class="fixed inset-0 z-40 bg-black/30 md:hidden"
      @click="mobileOpen = false"
    />
    <HomeSidebar :mobile-open="mobileOpen" @close="mobileOpen = false" />
    <main class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <div class="flex h-12 shrink-0 items-center border-b border-border px-3 md:hidden">
        <Button size="sm" variant="ghost" class="size-9 px-0" @click="mobileOpen = true">
          <Menu class="size-5" />
        </Button>
      </div>
      <RouterView />
    </main>
    <WorkspaceFolderDialog />
  </div>
</template>
