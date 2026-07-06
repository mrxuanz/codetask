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
  <main :class="cn('relative flex min-h-screen items-center justify-center p-4', props.class)">
    <div class="absolute right-4 top-4">
      <LanguageSwitcher />
    </div>
    <div :class="cn('w-full', maxWidthClass)">
      <slot />
    </div>
  </main>
</template>
