<script setup lang="ts">
import { type HTMLAttributes } from 'vue'
import { cn } from '@renderer/lib/utils'

defineProps<{
  class?: HTMLAttributes['class']
}>()
</script>

<template>
  <div
    :class="
      cn('rounded-lg border border-border bg-card text-card-foreground shadow-sm', $props.class)
    "
  >
    <slot />
  </div>
</template>
