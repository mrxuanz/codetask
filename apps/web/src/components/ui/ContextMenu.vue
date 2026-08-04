<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue'
import { cn } from '@renderer/lib/utils'

export interface ContextMenuItem {
  id: string
  label: string
  destructive?: boolean
}

const props = defineProps<{
  open: boolean
  x: number
  y: number
  items: ContextMenuItem[]
}>()

const emit = defineEmits<{
  select: [id: string]
  close: []
}>()

const menuRef = ref<HTMLElement | null>(null)
const position = ref({ x: props.x, y: props.y })

function onDocumentPointerDown(event: MouseEvent): void {
  if (!props.open) return
  const target = event.target as Node | null
  if (menuRef.value?.contains(target ?? null)) return
  emit('close')
}

function onDocumentKeyDown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && props.open) emit('close')
}

watch(
  () => [props.open, props.x, props.y] as const,
  () => {
    if (!props.open) return
    const margin = 8
    const width = 180
    const height = Math.max(1, props.items.length) * 36 + 8
    let x = props.x
    let y = props.y
    if (typeof window !== 'undefined') {
      x = Math.min(x, window.innerWidth - width - margin)
      y = Math.min(y, window.innerHeight - height - margin)
    }
    position.value = { x, y }
  },
  { immediate: true }
)

onMounted(() => {
  document.addEventListener('mousedown', onDocumentPointerDown)
  document.addEventListener('keydown', onDocumentKeyDown)
})

onUnmounted(() => {
  document.removeEventListener('mousedown', onDocumentPointerDown)
  document.removeEventListener('keydown', onDocumentKeyDown)
})
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      ref="menuRef"
      class="fixed z-50 min-w-[10rem] overflow-hidden rounded-md border border-border bg-card py-1 text-card-foreground shadow-lg"
      :style="{ left: `${position.x}px`, top: `${position.y}px` }"
      @contextmenu.prevent
    >
      <button
        v-for="item in items"
        :key="item.id"
        type="button"
        :class="
          cn(
            'flex w-full items-center bg-card px-3 py-2 text-left text-sm hover:bg-muted',
            item.destructive && 'text-destructive hover:bg-red-50'
          )
        "
        @click="emit('select', item.id)"
      >
        {{ item.label }}
      </button>
    </div>
  </Teleport>
</template>
