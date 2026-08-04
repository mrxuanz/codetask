<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import Button from '@renderer/components/ui/Button.vue'
import Dialog from '@renderer/components/ui/Dialog.vue'

defineProps<{
  open: boolean
  title: string
  message: string
  confirmLabel?: string
  loading?: boolean
}>()

const emit = defineEmits<{
  close: []
  confirm: []
}>()

const { t } = useI18n()
</script>

<template>
  <Dialog :open="open" class="max-w-md" @close="emit('close')">
    <div class="p-5">
      <h2 class="text-base font-semibold">{{ title }}</h2>
      <p class="mt-2 text-sm text-muted-foreground">{{ message }}</p>
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
        <Button
          type="button"
          size="sm"
          class="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          :disabled="loading"
          @click="emit('confirm')"
        >
          {{ confirmLabel ?? t('common.delete') }}
        </Button>
      </div>
    </div>
  </Dialog>
</template>
