<script setup lang="ts">
import { type HTMLAttributes } from 'vue'
import { cn } from '@renderer/lib/utils'

defineProps<{
  class?: HTMLAttributes['class']
}>()
</script>

<template>
  <div :class="cn('p-4 pt-0 sm:p-6 sm:pt-0', $props.class)">
    <slot />
  </div>
</template>
