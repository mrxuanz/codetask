<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { getAppLocale, setAppLocale, type AppLocale } from '@renderer/i18n'

const { t } = useI18n()

const current = computed(() => getAppLocale())

const options: { value: AppLocale; labelKey: string }[] = [
  { value: 'zh', labelKey: 'language.zh' },
  { value: 'ja', labelKey: 'language.ja' },
  { value: 'en', labelKey: 'language.en' }
]

function onChange(event: Event): void {
  const value = (event.target as HTMLSelectElement).value as AppLocale
  setAppLocale(value)
}
</script>

<template>
  <label class="flex items-center gap-2 text-sm text-muted-foreground">
    <span class="sr-only">{{ t('language.label') }}</span>
    <select
      class="rounded-md border border-input bg-background px-2 py-1 text-sm text-foreground shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
      :value="current"
      :aria-label="t('language.label')"
      @change="onChange"
    >
      <option v-for="opt in options" :key="opt.value" :value="opt.value">
        {{ t(opt.labelKey) }}
      </option>
    </select>
  </label>
</template>
