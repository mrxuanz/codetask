<script setup lang="ts">
import { type HTMLAttributes } from 'vue'
import { cn } from '@renderer/lib/utils'

defineProps<{
  class?: HTMLAttributes['class']
  as?: 'h1' | 'h2' | 'h3'
}>()
</script>

<template>
  <component :is="as ?? 'h2'" :class="cn('text-2xl font-semibold tracking-tight', $props.class)">
    <slot />
  </component>
</template>
