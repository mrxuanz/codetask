<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { cn } from '@renderer/lib/utils'
import { escapeMarkdownPreviewHtml, renderMarkdownPreview } from '@renderer/lib/markdownPreview'

const props = withDefaults(
  defineProps<{
    modelValue: string
    readonly?: boolean
    /** Hide edit/preview tabs and show scrollable preview only. Defaults to true when readonly. */
    previewOnly?: boolean
    /** Card-style section layout for requirements contract preview. */
    variant?: 'default' | 'contract'
    minHeight?: string
    maxHeight?: string
    placeholder?: string
    saving?: boolean
  }>(),
  {
    readonly: false,
    previewOnly: undefined,
    variant: 'default',
    minHeight: '16rem',
    maxHeight: 'min(28rem, 55vh)',
    placeholder: '',
    saving: false
  }
)

const emit = defineEmits<{
  'update:modelValue': [value: string]
  blur: []
}>()

const { t } = useI18n()
const mode = ref<'edit' | 'preview'>('edit')

const isPreviewOnly = computed(() => props.previewOnly ?? props.readonly)

const previewHtml = computed(() => {
  const markdown = props.modelValue.trim()
  if (!markdown) {
    return `<p class="text-muted-foreground">${escapeMarkdownPreviewHtml(t('workspace.draft.markdownEmpty'))}</p>`
  }

  return renderMarkdownPreview(markdown, props.variant)
})

function handleInput(event: Event): void {
  emit('update:modelValue', (event.target as HTMLTextAreaElement).value)
}
</script>

<template>
  <div
    :class="
      cn(
        'rounded-md border border-input bg-background',
        isPreviewOnly ? 'flex min-h-0 flex-col' : 'overflow-hidden'
      )
    "
  >
    <!-- Preview renderers escape every user-controlled token before adding fixed markup. -->
    <!-- eslint-disable-next-line vue/no-v-html -->
    <!-- previewHtml is produced by renderMarkdownPreview, which escapes raw HTML before rendering. -->
    <!-- eslint-disable vue/no-v-html -->
    <div
      v-if="!isPreviewOnly"
      class="flex items-center justify-between border-b border-border bg-muted/30 px-2 py-1"
    >
      <div class="flex gap-1">
        <button
          type="button"
          class="rounded px-2 py-0.5 text-[11px] font-medium transition-colors"
          :class="
            mode === 'edit' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground'
          "
          @click="mode = 'edit'"
        >
          {{ t('workspace.draft.markdownEdit') }}
        </button>
        <button
          type="button"
          class="rounded px-2 py-0.5 text-[11px] font-medium transition-colors"
          :class="
            mode === 'preview' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground'
          "
          @click="mode = 'preview'"
        >
          {{ t('workspace.draft.markdownPreview') }}
        </button>
      </div>
      <span v-if="saving" class="text-[11px] text-muted-foreground">{{
        t('workspace.draft.saving')
      }}</span>
    </div>

    <textarea
      v-if="!isPreviewOnly && mode === 'edit'"
      :value="modelValue"
      :readonly="readonly"
      :placeholder="placeholder"
      spellcheck="false"
      :class="
        cn(
          'w-full resize-y border-0 bg-transparent px-3 py-2 font-mono text-xs leading-relaxed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset disabled:cursor-not-allowed disabled:opacity-60',
          readonly && 'cursor-default'
        )
      "
      :style="{ minHeight }"
      @input="handleInput"
      @blur="emit('blur')"
    />

    <div
      v-else
      :class="
        cn(
          'min-h-0 overflow-y-auto overscroll-contain px-3 py-2 text-xs leading-relaxed text-foreground',
          variant === 'contract' && 'space-y-3 py-3'
        )
      "
      :style="isPreviewOnly ? { maxHeight } : { minHeight }"
      v-html="previewHtml"
    />
    <!-- eslint-enable vue/no-v-html -->
  </div>
</template>
