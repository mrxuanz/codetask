export type ReferenceSource = 'attachment' | 'local_corpus'
export type ReferenceKind = 'file' | 'directory' | 'image'

export interface DraftReference {
  id: string
  source: ReferenceSource
  name: string
  kind: ReferenceKind
  description: string
  attachmentId?: string
  assetUrl?: string
  localPath?: string
  mimeType?: string
}

export interface ReferenceManifestEntry {
  id: string
  source: ReferenceSource
  name: string
  kind: ReferenceKind
  description: string
  resolvedPath: string
  readonly: true
  inWorkspace: boolean

  relativePath?: string
  mimeType?: string
  assetUrl?: string
  requiresDescription?: boolean
  excludedFromCoverage?: boolean
}

export interface ReferenceManifest {
  designSessionId?: string

  jobId?: string
  draftMessageId?: string
  threadId: string
  manifestRevision: number
  frozenAt: string
  ignoredReferenceIds: string[]
  references: ReferenceManifestEntry[]
}

export function isReferenceManifest(value: unknown): value is ReferenceManifest {
  if (!value || typeof value !== 'object') return false
  const obj = value as Record<string, unknown>
  return typeof obj.threadId === 'string' && Array.isArray(obj.references)
}

export function normalizeReferenceManifest(raw: unknown): ReferenceManifest | null {
  if (!isReferenceManifest(raw)) return null
  const manifest = raw as ReferenceManifest
  if (!manifest.references.every((entry) => typeof entry.id === 'string')) return null
  return {
    designSessionId: manifest.designSessionId ?? manifest.jobId,
    jobId: manifest.jobId ?? manifest.designSessionId,
    draftMessageId: manifest.draftMessageId,
    threadId: manifest.threadId,
    manifestRevision: manifest.manifestRevision ?? 0,
    frozenAt: manifest.frozenAt,
    ignoredReferenceIds: manifest.ignoredReferenceIds ?? [],
    references: manifest.references.map((entry) => ({
      ...entry,
      readonly: true as const,
      kind: entry.kind ?? (entry.mimeType?.startsWith('image/') ? 'image' : 'file'),
      source: entry.source ?? 'attachment',
      inWorkspace: entry.inWorkspace ?? false,
      resolvedPath: entry.resolvedPath ?? ''
    }))
  }
}

export function parseReferenceManifest(raw: string | null | undefined): ReferenceManifest | null {
  if (!raw?.trim()) return null
  try {
    return normalizeReferenceManifest(JSON.parse(raw))
  } catch {
    return null
  }
}

export function validatePlanReferenceIdsAgainstManifest(
  plan: {
    milestones: Array<{
      slices: Array<{
        tasks: Array<{ referenceIds?: string[] }>
      }>
    }>
  },
  manifest: ReferenceManifest
): string[] {
  const available = new Set(manifest.references.map((item) => item.id))
  const invalid: string[] = []
  for (const milestone of plan.milestones) {
    for (const slice of milestone.slices) {
      for (const task of slice.tasks) {
        for (const id of task.referenceIds ?? []) {
          if (!available.has(id)) {
            invalid.push(id)
          }
        }
      }
    }
  }
  return [...new Set(invalid)]
}
