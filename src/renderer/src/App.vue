<script setup lang="ts">
import { RouterView } from 'vue-router'
import { provideBootstrap } from '@renderer/composables/useBootstrap'

provideBootstrap()
</script>

<template>
  <RouterView />
</template>
