export function escapeMarkdownPreviewHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function inlineMarkdown(text: string): string {
  return escapeMarkdownPreviewHtml(text)
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
    return `<h2 class="mb-2 mt-4 text-lg font-semibold first:mt-0">${inlineMarkdown(trimmed.slice(2))}</h2>`
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
    if (!listOpen) return
    parts.push(listOpen === 'ul' ? '</ul>' : '</ol>')
    listOpen = null
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
      current = { level: headingMatch[1].length, title: headingMatch[2], lines: [] }
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
        `<h2 class="mb-3 text-sm font-semibold text-foreground">${inlineMarkdown(section.title)}</h2>`
      )
      if (body) parts.push(`<div class="mb-3 space-y-1">${renderDefaultPreview(body)}</div>`)
      continue
    }
    const bodyHtml = body ? renderDefaultPreview(body) : ''
    parts.push(
      `<section class="rounded-lg bg-muted/30 p-3">` +
        `<h3 class="text-xs font-medium text-muted-foreground">${inlineMarkdown(section.title)}</h3>` +
        (bodyHtml
          ? `<div class="mt-2 space-y-1 whitespace-pre-wrap text-xs text-foreground">${bodyHtml}</div>`
          : '') +
        `</section>`
    )
  }
  return `<div class="space-y-3">${parts.join('')}</div>`
}

export function renderMarkdownPreview(markdown: string, variant: 'default' | 'contract'): string {
  return variant === 'contract' ? renderContractPreview(markdown) : renderDefaultPreview(markdown)
}
