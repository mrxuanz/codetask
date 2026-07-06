export interface DraftReferenceLike {
  id: string
  name: string
  mimeType?: string
  kind?: 'image' | 'file' | 'directory'
  description?: string
  assetUrl?: string
}

const TEXT_LIKE_REFERENCE_EXTENSIONS = new Set([
  'txt',
  'csv',
  'md',
  'json',
  'xml',
  'yaml',
  'yml',
  'html',
  'htm',
  'css',
  'js',
  'ts',
  'jsx',
  'tsx',
  'py',
  'java',
  'c',
  'cpp',
  'h',
  'hpp',
  'rb',
  'php',
  'go',
  'rs',
  'sql',
  'sh',
  'bash',
  'log'
])

export function referenceRequiresDescription(reference: DraftReferenceLike): boolean {
  if (reference.kind === 'image' || reference.kind === 'directory') return true
  if (reference.mimeType?.startsWith('text/')) return false
  const ext = reference.name.split('.').pop()?.toLowerCase() ?? ''
  return !TEXT_LIKE_REFERENCE_EXTENSIONS.has(ext)
}

export function referenceDescriptionMissing(reference: DraftReferenceLike): boolean {
  if (!referenceRequiresDescription(reference)) return false
  return !reference.description?.trim()
}

export function collectMissingReferenceDescriptions(references: DraftReferenceLike[]): string[] {
  return references.filter((item) => referenceDescriptionMissing(item)).map((item) => item.name)
}

export function formatReferenceDescriptionError(missingNames: string[]): string {
  if (missingNames.length === 0) return ''
  const preview = missingNames.slice(0, 3).join(', ')
  const suffix = missingNames.length > 3 ? ` and ${missingNames.length} more` : ''
  return `Reference descriptions required for: ${preview}${suffix}`
}

export function buildAssignedReferencesMarkdown(input: {
  references: DraftReferenceLike[]
  referenceIds: string[]
  referenceReason?: string
  assetUrlBase?: string

  localPathById?: ReadonlyMap<string, string>

  requireLocalPaths?: boolean
}): string {
  if (input.referenceIds.length === 0) return ''

  const byId = new Map(input.references.map((item) => [item.id, item]))
  const lines = [
    '## Assigned Draft References',
    'Use these materials when implementing this task. Match layout, copy, and structure from descriptions and on-disk files.',
    'Reference files are read-only; do not modify them.',
    ''
  ]

  if (input.referenceReason?.trim()) {
    lines.push(`Planner note: ${input.referenceReason.trim()}`, '')
  }

  for (const id of input.referenceIds) {
    const ref = byId.get(id)
    if (!ref) {
      lines.push(`- id: ${id} (missing from draft — do not invent content)`)
      continue
    }
    const localPath = input.localPathById?.get(id)
    lines.push(
      `- id: ${id}`,
      `  name: ${ref.name}`,
      `  kind: ${ref.kind ?? 'file'}`,
      `  description: ${ref.description?.trim() || '(no description — infer only from task context)'}`
    )
    if (localPath) {
      lines.push(`  localPath: ${localPath}`)
    } else if (input.requireLocalPaths) {
      lines.push('  localPath: (MISSING — reference file is not readable on disk)')
    } else if (ref.assetUrl || input.assetUrlBase) {
      lines.push(`  preview: ${ref.assetUrl ?? `${input.assetUrlBase ?? ''}/attachments/${id}`}`)
    }
  }

  return lines.join('\n')
}
