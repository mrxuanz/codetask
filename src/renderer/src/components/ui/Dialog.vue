<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue'
import { cn } from '@renderer/lib/utils'

const props = defineProps<{
  open: boolean
  class?: string
}>()

const emit = defineEmits<{
  close: []
}>()

function onKeyDown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && props.open) {
    emit('close')
  }
}

onMounted(() => window.addEventListener('keydown', onKeyDown))
onUnmounted(() => window.removeEventListener('keydown', onKeyDown))
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="fixed inset-0 z-50 flex items-start justify-center bg-black/30 p-6 pt-[12vh]"
    >
      <button
        type="button"
        class="absolute inset-0 cursor-default"
        :aria-label="$t('folderPicker.close')"
        @click="emit('close')"
      />
      <div
        role="dialog"
        aria-modal="true"
        :class="
          cn(
            'relative z-10 w-full max-w-lg overflow-hidden rounded-xl border border-border bg-card shadow-xl',
            props.class
          )
        "
      >
        <slot />
      </div>
    </div>
  </Teleport>
</template>
