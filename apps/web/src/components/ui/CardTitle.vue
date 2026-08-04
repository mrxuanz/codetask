<script setup lang="ts">
import { type HTMLAttributes } from 'vue'
import { cn } from '@renderer/lib/utils'

defineProps<{
  class?: HTMLAttributes['class']
}>()
</script>

<template>
  <h1 :class="cn('text-2xl font-semibold tracking-tight', $props.class)">
    <slot />
  </h1>
</template>
