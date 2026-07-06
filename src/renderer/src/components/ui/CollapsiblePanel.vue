<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { ChevronLeft, ChevronRight } from 'lucide-vue-next'
import { cn } from '@renderer/lib/utils'

const props = withDefaults(
  defineProps<{
    collapsed: boolean
    side: 'left' | 'right'
    label: string
    width?: string
    minWidth?: string
    grow?: boolean
  }>(),
  {
    width: 'min(360px, 32vw)',
    minWidth: '280px',
    grow: false
  }
)

const emit = defineEmits<{
  'update:collapsed': [value: boolean]
}>()

const { t } = useI18n()

function expand(): void {
  emit('update:collapsed', false)
}

function collapse(): void {
  emit('update:collapsed', true)
}
</script>

<template>
  <div
    v-if="collapsed"
    class="relative flex h-full w-9 shrink-0 flex-col border-border bg-muted/30"
  >
    <div
      :class="
        cn(
          'flex h-full flex-col items-center border-border py-2',
          side === 'left' ? 'border-r' : 'border-l'
        )
      "
    >
      <button
        type="button"
        class="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
        :aria-label="t('workspace.layout.expandPanel', { label })"
        @click="expand"
      >
        <ChevronLeft class="size-3.5" aria-hidden="true" />
      </button>
      <span
        class="mt-3 select-none text-[10px] font-medium tracking-wide text-muted-foreground [writing-mode:vertical-rl]"
      >
        {{ label }}
      </span>
    </div>
  </div>

  <div
    v-else
    class="relative flex h-full min-h-0 shrink-0 flex-col border-border bg-background"
    :class="[side === 'left' ? 'border-r' : 'border-l', grow && 'min-w-0 flex-1']"
    :style="grow ? undefined : { width: props.width, minWidth: props.minWidth }"
  >
    <button
      type="button"
      class="absolute top-2 z-10 flex size-7 items-center justify-center rounded-md border border-border bg-card text-muted-foreground shadow-sm hover:text-foreground"
      :class="side === 'left' ? 'right-1' : 'left-1'"
      :aria-label="t('workspace.layout.collapsePanel', { label })"
      @click="collapse"
    >
      <ChevronRight class="size-3.5" aria-hidden="true" />
    </button>
    <div class="flex min-h-0 flex-1 flex-col overflow-hidden">
      <slot />
    </div>
  </div>
</template>
