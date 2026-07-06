<script setup lang="ts">
import { type HTMLAttributes } from 'vue'
import { cn } from '@renderer/lib/utils'

defineProps<{
  class?: HTMLAttributes['class']
}>()
</script>

<template>
  <div :class="cn('flex flex-col gap-1.5 p-6 pb-4', $props.class)">
    <slot />
  </div>
</template>
