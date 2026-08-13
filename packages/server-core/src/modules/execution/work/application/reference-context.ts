import { dirname, isAbsolute, normalize, parse } from 'node:path'
import type { ReferenceManifest } from '@codetask/contracts'

export type AssignedReferenceContext = {
  readRoots: string[]
  promptAppendix: string
}

/** Build the frozen, read-only reference projection shared by planners and task workers. */
export function buildAssignedReferenceContext(
  manifest: ReferenceManifest,
  referenceIds: readonly string[],
  assignment: { referenceReason?: string; requiredInputs?: readonly string[] } = {},
  resolveAttachmentPath?: (attachmentId: string) => string | null
): AssignedReferenceContext {
  const byId = new Map(manifest.references.map((reference) => [reference.id, reference]))
  const roots = new Map<string, string>()
  const lines = [
    '## Assigned Reference Corpus',
    'Use these read-only materials when relevant. Do not modify them.',
    ''
  ]

  const referenceReason = assignment.referenceReason?.trim()
  if (referenceReason) lines.push(`Assignment reason: ${referenceReason}`, '')
  const requiredInputs = (assignment.requiredInputs ?? [])
    .map((value) => value.trim())
    .filter(Boolean)
  if (requiredInputs.length > 0) {
    lines.push('Required inputs:')
    for (const requiredInput of requiredInputs) lines.push(`- ${requiredInput}`)
    lines.push('')
  }

  for (const id of referenceIds) {
    const reference = byId.get(id)
    if (!reference) {
      lines.push(`- id: ${id} (missing from frozen manifest)`)
      continue
    }
    const registeredPath = reference.attachmentId
      ? resolveAttachmentPath?.(reference.attachmentId)?.trim()
      : ''
    const rawPath =
      registeredPath || reference.resolvedPath?.trim() || reference.localPath?.trim() || ''
    const resolvedPath = rawPath && isAbsolute(rawPath) ? normalize(rawPath) : ''
    if (resolvedPath) {
      const root = reference.kind === 'directory' ? resolvedPath : dirname(resolvedPath)
      if (root !== parse(root).root) roots.set(root.toLowerCase(), root)
    }
    lines.push(
      `- id: ${reference.id}`,
      `  name: ${reference.name}`,
      `  kind: ${reference.kind}`,
      `  description: ${reference.description.trim() || '(no description)'}`
    )
    if (resolvedPath) lines.push(`  resolvedPath: ${resolvedPath}`)
  }

  return {
    readRoots: [...roots.values()],
    promptAppendix:
      referenceIds.length > 0 || referenceReason || requiredInputs.length > 0
        ? lines.join('\n')
        : ''
  }
}
