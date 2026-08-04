<script setup lang="ts">
import { type HTMLAttributes } from 'vue'
import { cn } from '@renderer/lib/utils'

defineProps<{
  message: string
  class?: HTMLAttributes['class']
}>()
</script>

<template>
  <div
    role="alert"
    :class="
      cn(
        'rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive',
        $props.class
      )
    "
  >
    {{ message }}
  </div>
</template>
