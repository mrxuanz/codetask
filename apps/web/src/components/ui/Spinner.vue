<script setup lang="ts">
import { useI18n } from 'vue-i18n'

defineProps<{
  class?: string
}>()

const { t } = useI18n()
</script>

<template>
  <div class="flex items-center justify-center py-4" :class="$props.class">
    <div
      class="size-8 animate-spin rounded-full border-2 border-muted border-t-primary"
      :aria-label="t('common.loading')"
    />
  </div>
</template>
