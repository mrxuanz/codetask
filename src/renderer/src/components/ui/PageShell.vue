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
  <!--
    #app is height-locked with overflow:hidden. This shell must be h-full + overflow-y-auto
    so tall auth/setup forms remain scrollable on phones. Inner min-h-full + justify-center
    centers short forms without clipping tall ones (classic flex centering scroll trap).
  -->
  <main
    :class="
      cn(
        'relative h-full min-h-0 w-full min-w-0 overflow-x-hidden overflow-y-auto overscroll-contain',
        props.class
      )
    "
  >
    <div class="absolute right-3 top-3 z-10 sm:right-4 sm:top-4">
      <LanguageSwitcher />
    </div>
    <div
      :class="
        cn(
          'mx-auto flex min-h-full w-full min-w-0 flex-col justify-center px-3 pb-8 pt-14 sm:px-4 sm:py-6',
          maxWidthClass
        )
      "
    >
      <slot />
    </div>
  </main>
</template>
