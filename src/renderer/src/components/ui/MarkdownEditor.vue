<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { cn } from '@renderer/lib/utils'

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

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function inlineMarkdown(text: string): string {
  return escapeHtml(text)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code class="rounded bg-muted px-1 py-0.5 text-[11px]">$1</code>')
}

function renderLine(line: string): string {
  const trimmed = line.trim()
  if (!trimmed) return ''
  if (trimmed.startsWith('### ')) {
    return `<h3 class="mb-1 mt-3 text-sm font-semibold first:mt-0">${inlineMarkdown(trimmed.slice(4))}</h3>`
  }
  if (trimmed.startsWith('## ')) {
    return `<h2 class="mb-2 mt-4 text-base font-semibold first:mt-0">${inlineMarkdown(trimmed.slice(3))}</h2>`
  }
  if (trimmed.startsWith('# ')) {
    return `<h1 class="mb-2 mt-4 text-lg font-semibold first:mt-0">${inlineMarkdown(trimmed.slice(2))}</h1>`
  }
  if (/^\d+\.\s+/.test(trimmed)) {
    return `<li class="ml-4 list-decimal text-xs leading-relaxed">${inlineMarkdown(trimmed.replace(/^\d+\.\s+/, ''))}</li>`
  }
  if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
    return `<li class="ml-4 list-disc text-xs leading-relaxed">${inlineMarkdown(trimmed.slice(2))}</li>`
  }
  return `<p class="text-xs leading-relaxed">${inlineMarkdown(trimmed)}</p>`
}

function renderDefaultPreview(markdown: string): string {
  const parts: string[] = []
  let listOpen: 'ul' | 'ol' | null = null

  const closeList = (): void => {
    if (listOpen) {
      parts.push(listOpen === 'ul' ? '</ul>' : '</ol>')
      listOpen = null
    }
  }

  for (const line of markdown.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) {
      closeList()
      parts.push('<div class="h-2" aria-hidden="true"></div>')
      continue
    }

    const isOrdered = /^\d+\.\s+/.test(trimmed)
    const isBullet = trimmed.startsWith('- ') || trimmed.startsWith('* ')

    if (isOrdered || isBullet) {
      const nextList = isOrdered ? 'ol' : 'ul'
      if (listOpen !== nextList) {
        closeList()
        parts.push(
          nextList === 'ul'
            ? '<ul class="my-1 space-y-1 pl-4">'
            : '<ol class="my-1 space-y-1 pl-4">'
        )
        listOpen = nextList
      }
      parts.push(renderLine(line))
      continue
    }

    closeList()
    parts.push(renderLine(line))
  }
  closeList()
  return parts.join('')
}

function renderContractPreview(markdown: string): string {
  type Section = { level: number; title: string; lines: string[] }
  const sections: Section[] = []
  let current: Section | null = null

  for (const line of markdown.split('\n')) {
    const trimmed = line.trim()
    const headingMatch = trimmed.match(/^(#{1,3})\s+(.+)$/)
    if (headingMatch) {
      if (current) sections.push(current)
      current = {
        level: headingMatch[1].length,
        title: headingMatch[2],
        lines: []
      }
      continue
    }
    if (current) current.lines.push(line)
  }
  if (current) sections.push(current)

  if (sections.length === 0) return renderDefaultPreview(markdown)

  const parts: string[] = []
  for (const section of sections) {
    const body = section.lines.join('\n').trim()
    if (section.level === 1) {
      parts.push(
        `<h1 class="mb-3 text-sm font-semibold text-foreground">${inlineMarkdown(section.title)}</h1>`
      )
      if (body) parts.push(`<div class="mb-3 space-y-1">${renderDefaultPreview(body)}</div>`)
      continue
    }

    const bodyHtml = body ? renderDefaultPreview(body) : ''
    parts.push(
      `<section class="rounded-lg bg-muted/30 p-3">` +
        `<div class="text-xs font-medium text-muted-foreground">${inlineMarkdown(section.title)}</div>` +
        (bodyHtml
          ? `<div class="mt-2 space-y-1 whitespace-pre-wrap text-xs text-foreground">${bodyHtml}</div>`
          : '') +
        `</section>`
    )
  }

  return `<div class="space-y-3">${parts.join('')}</div>`
}

const previewHtml = computed(() => {
  const markdown = props.modelValue.trim()
  if (!markdown) {
    return `<p class="text-muted-foreground">${escapeHtml(t('workspace.draft.markdownEmpty'))}</p>`
  }

  return props.variant === 'contract'
    ? renderContractPreview(markdown)
    : renderDefaultPreview(markdown)
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
  </div>
</template>
