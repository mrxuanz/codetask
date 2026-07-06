<script setup lang="ts">
import { ref, watch } from 'vue'

const props = defineProps<{
  label: string
  modelValue: string
  placeholder?: string
  editable?: boolean
  disabled?: boolean
  rows?: number
  mono?: boolean
}>()

const emit = defineEmits<{
  save: [value: string]
}>()

const draft = ref(props.modelValue)

watch(
  () => props.modelValue,
  (value) => {
    draft.value = value
  }
)

function handleBlur(): void {
  if (draft.value !== props.modelValue) {
    emit('save', draft.value)
  }
}
</script>

<template>
  <div>
    <p class="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
      {{ label }}
    </p>
    <textarea
      v-if="editable"
      v-model="draft"
      :placeholder="placeholder"
      :rows="rows ?? 3"
      :disabled="disabled"
      class="mt-2 w-full resize-y rounded-md border border-border/50 bg-background px-3 py-2 text-sm leading-relaxed outline-none transition-colors placeholder:text-muted-foreground/70 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
      :class="mono && 'font-mono text-xs'"
      @blur="handleBlur"
    />
    <pre
      v-else-if="modelValue.trim()"
      class="mt-2 max-h-72 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-muted/30 p-3 text-xs leading-relaxed"
      :class="!mono && 'text-sm font-sans'"
      >{{ modelValue }}</pre
    >
    <p v-else class="mt-1 text-sm text-muted-foreground/70">
      {{ placeholder || '—' }}
    </p>
  </div>
</template>
