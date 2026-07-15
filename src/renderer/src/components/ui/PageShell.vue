<script setup lang="ts">
import { computed } from 'vue'
import LanguageSwitcher from '@renderer/components/LanguageSwitcher.vue'
import { cn } from '@renderer/lib/utils'

const props = withDefaults(
  defineProps<{
    maxWidth?: 'sm' | 'md' | 'lg' | 'xl'
    class?: string
  }>(),
  { maxWidth: 'md' }
)

const maxWidthClass = computed(() => {
  const map = {
    sm: 'max-w-sm',
    md: 'max-w-md',
    lg: 'max-w-lg',
    xl: 'max-w-xl'
  } as const
  return map[props.maxWidth]
})
</script>

<template>
  <main
    :class="
      cn(
        'relative flex min-h-[100dvh] items-start justify-center overflow-y-auto px-3 pb-6 pt-14 sm:items-center sm:px-4 sm:py-6',
        props.class
      )
    "
  >
    <div class="absolute right-3 top-3 z-10 sm:right-4 sm:top-4">
      <LanguageSwitcher />
    </div>
    <div :class="cn('w-full', maxWidthClass)">
      <slot />
    </div>
  </main>
</template>
