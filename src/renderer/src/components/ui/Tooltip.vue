<script setup lang="ts">
import { computed, ref } from 'vue'
import { cn } from '@renderer/lib/utils'

const props = withDefaults(
  defineProps<{
    label: string
    side?: 'top' | 'right' | 'left'
  }>(),
  {
    side: 'top'
  }
)

const anchorRef = ref<HTMLElement | null>(null)
const visible = ref(false)

const tooltipStyle = computed(() => {
  const el = anchorRef.value
  if (!el) return { display: 'none' }

  const rect = el.getBoundingClientRect()
  const gap = 8

  if (props.side === 'right') {
    return {
      top: `${rect.top + rect.height / 2}px`,
      left: `${rect.right + gap}px`,
      transform: 'translateY(-50%)'
    }
  }
  if (props.side === 'left') {
    return {
      top: `${rect.top + rect.height / 2}px`,
      left: `${rect.left - gap}px`,
      transform: 'translate(-100%, -50%)'
    }
  }
  return {
    top: `${rect.top - gap}px`,
    left: `${rect.left + rect.width / 2}px`,
    transform: 'translate(-50%, -100%)'
  }
})

function show(): void {
  visible.value = true
}

function hide(): void {
  visible.value = false
}
</script>

<template>
  <span
    ref="anchorRef"
    class="inline-flex"
    @mouseenter="show"
    @mouseleave="hide"
    @focusin="show"
    @focusout="hide"
  >
    <slot />
  </span>
  <Teleport to="body">
    <span
      v-if="visible"
      role="tooltip"
      :class="
        cn(
          'pointer-events-none fixed z-[100] whitespace-nowrap rounded-md border border-border bg-card px-2 py-1 text-[11px] font-medium text-foreground shadow-sm'
        )
      "
      :style="tooltipStyle"
    >
      {{ label }}
    </span>
  </Teleport>
</template>
