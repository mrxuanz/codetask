<script setup lang="ts">
import { RouterView } from 'vue-router'
import Toaster from '@renderer/components/ui/Sonner.vue'
import { provideBootstrap } from '@renderer/composables/useBootstrap'
import 'vue-sonner/style.css'

provideBootstrap()
</script>

<template>
  <div class="h-full min-h-0 min-w-0">
    <RouterView />
    <Toaster class="pointer-events-auto" />
  </div>
</template>
