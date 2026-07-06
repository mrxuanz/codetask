<script setup lang="ts">
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import Button from '@renderer/components/ui/Button.vue'
import Dialog from '@renderer/components/ui/Dialog.vue'

const props = defineProps<{
  open: boolean
  title: string
  initialValue?: string
  loading?: boolean
}>()

const emit = defineEmits<{
  close: []
  confirm: [value: string]
}>()

const { t } = useI18n()
const value = ref('')

watch(
  () => [props.open, props.initialValue] as const,
  ([open, initial]) => {
    if (open) value.value = initial ?? ''
  },
  { immediate: true }
)

function submit(): void {
  const trimmed = value.value.trim()
  if (!trimmed) return
  emit('confirm', trimmed)
}
</script>

<template>
  <Dialog :open="open" class="max-w-md" @close="emit('close')">
    <div class="p-5">
      <h2 class="text-base font-semibold">{{ title }}</h2>
      <input
        v-model="value"
        type="text"
        class="mt-3 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
        :placeholder="t('workspace.sidebar.renamePlaceholder')"
        @keydown.enter="submit"
      />
      <div class="mt-5 flex justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          :disabled="loading"
          @click="emit('close')"
        >
          {{ t('common.cancel') }}
        </Button>
        <Button type="button" size="sm" :disabled="loading || !value.trim()" @click="submit">
          {{ t('common.save') }}
        </Button>
      </div>
    </div>
  </Dialog>
</template>
