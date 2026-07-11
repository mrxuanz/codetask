<script setup lang="ts">
import { computed } from 'vue'
import LanguageSwitcher from '@renderer/components/LanguageSwitcher.vue'
import { cn } from '@renderer/lib/utils'

const props = withDefaults(
  defineProps<{
    maxWidth?: 'sm' | 'md' | 'lg'
    class?: string
  }>(),
  { maxWidth: 'md' }
)

const maxWidthClass = computed(() => {
  const map = { sm: 'max-w-sm', md: 'max-w-md', lg: 'max-w-lg' } as const
  return map[props.maxWidth]
})
</script>

<template>
  <main :class="cn('relative flex min-h-[100dvh] items-center justify-center px-4 pb-4 pt-16 sm:p-4', props.class)">
    <div class="absolute right-3 top-3 sm:right-4 sm:top-4">
      <LanguageSwitcher />
    </div>
    <div :class="cn('w-full', maxWidthClass)">
      <slot />
    </div>
  </main>
</template>
