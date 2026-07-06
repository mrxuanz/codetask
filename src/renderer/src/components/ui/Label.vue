<script setup lang="ts">
import { type HTMLAttributes } from 'vue'
import { cn } from '@renderer/lib/utils'

defineProps<{
  for?: string
  class?: HTMLAttributes['class']
}>()
</script>

<template>
  <label :for="$props.for" :class="cn('text-sm font-medium leading-none', $props.class)">
    <slot />
  </label>
</template>
