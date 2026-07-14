export interface JobReferenceEntry {
  id: string
  name: string
  kind: 'image' | 'file' | 'directory'
  mimeType: string
  description: string

  relativePath?: string | undefined

  resolvedPath?: string | undefined
  source?: 'attachment' | 'local_corpus' | undefined
  readonly: true
  requiresDescription: boolean
  inWorkspace?: boolean | undefined

  assetUrl: string
  excludedFromCoverage?: boolean | undefined
}

export interface JobReferenceManifest {
  jobId: string
  designSessionId?: string | undefined
  draftMessageId?: string | undefined
  threadId: string
  manifestRevision?: number | undefined
  frozenAt: string
  ignoredReferenceIds: string[]
  references: JobReferenceEntry[]
}

export interface JobReferenceManifestDto {
  jobId: string
  threadId: string
  frozenAt: string
  ignoredReferenceIds: string[]
  references: Array<{
    id: string
    name: string
    kind: 'image' | 'file' | 'directory'
    mimeType: string
    description: string
    relativePath?: string | undefined
    requiresDescription: boolean
    assetUrl: string
    excludedFromCoverage?: boolean | undefined
  }>
}

export interface TaskAssignedReference {
  id: string
  name: string
  kind: 'image' | 'file' | 'directory'
  description: string
  thumbnailUrl?: string | undefined
}

export function toPublicReferenceManifest(manifest: JobReferenceManifest): JobReferenceManifestDto {
  return {
    jobId: manifest.jobId,
    threadId: manifest.threadId,
    frozenAt: manifest.frozenAt,
    ignoredReferenceIds: manifest.ignoredReferenceIds,
    references: manifest.references.map((entry) => ({
      id: entry.id,
      name: entry.name,
      kind: entry.kind,
      mimeType: entry.mimeType,
      description: entry.description,
      relativePath: entry.relativePath,
      requiresDescription: entry.requiresDescription,
      assetUrl: entry.assetUrl,
      excludedFromCoverage: entry.excludedFromCoverage
    }))
  }
}

export function buildReferenceEntryFromDraft(ref: {
  id: string
  name: string
  mimeType?: string | undefined
  kind?: 'image' | 'file' | 'directory' | undefined
  assetUrl?: string | undefined
  relativePath?: string | undefined
  resolvedPath?: string | undefined
  source?: 'attachment' | 'local_corpus' | undefined
  inWorkspace?: boolean | undefined
  description?: string | undefined
  requiresDescription: boolean
}): JobReferenceEntry {
  return {
    id: ref.id,
    name: ref.name,
    kind: ref.kind ?? 'file',
    mimeType: ref.mimeType ?? 'application/octet-stream',
    description: ref.description?.trim() ?? '',
    relativePath: ref.relativePath,
    resolvedPath: ref.resolvedPath,
    source: ref.source,
    inWorkspace: ref.inWorkspace,
    readonly: true,
    requiresDescription: ref.requiresDescription,
    assetUrl: ref.assetUrl ?? '',
    excludedFromCoverage: false
  }
}

export function buildJobReferenceManifest(input: {
  jobId: string
  threadId: string
  references: Array<{
    id: string
    name: string
    mimeType?: string | undefined
    kind?: 'image' | 'file' | 'directory' | undefined
    assetUrl?: string | undefined
    relativePath?: string | undefined
    resolvedPath?: string | undefined
    source?: 'attachment' | 'local_corpus' | undefined
    inWorkspace?: boolean | undefined
    description?: string | undefined
    requiresDescription: boolean
  }>
  ignoredReferenceIds?: string[] | undefined
}): JobReferenceManifest {
  const ignored = new Set(input.ignoredReferenceIds ?? [])
  return {
    jobId: input.jobId,
    threadId: input.threadId,
    frozenAt: new Date().toISOString(),
    ignoredReferenceIds: [...ignored],
    references: input.references.map((ref) => ({
      ...buildReferenceEntryFromDraft(ref),
      excludedFromCoverage: ignored.has(ref.id)
    }))
  }
}

export function parseJobReferenceManifest(
  raw: string | null | undefined
): JobReferenceManifest | null {
  if (!raw?.trim()) return null
  try {
    const parsed = JSON.parse(raw) as JobReferenceManifest
    if (!parsed?.threadId || !Array.isArray(parsed.references)) return null
    const jobId = parsed.jobId ?? parsed.designSessionId ?? ''
    if (!jobId) return null
    return {
      ...parsed,
      jobId,
      designSessionId: parsed.designSessionId ?? jobId,
      manifestRevision: parsed.manifestRevision ?? 0,
      ignoredReferenceIds: parsed.ignoredReferenceIds ?? [],
      references: parsed.references.map((entry) => ({
        ...entry,
        kind: entry.kind ?? (entry.mimeType?.startsWith('image/') ? 'image' : 'file'),
        source: entry.source ?? 'attachment',
        readonly: true as const,
        requiresDescription: entry.requiresDescription ?? false,
        assetUrl: entry.assetUrl ?? '',
        relativePath: entry.relativePath,
        resolvedPath: entry.resolvedPath
      }))
    }
  } catch {
    return null
  }
}

export function collectPlanReferenceIds(plan: {
  milestones: Array<{
    slices: Array<{
      tasks: Array<{ referenceIds?: string[] | undefined }>
    }>
  }>
}): Set<string> {
  const used = new Set<string>()
  for (const milestone of plan.milestones) {
    for (const slice of milestone.slices) {
      for (const task of slice.tasks) {
        for (const id of task.referenceIds ?? []) {
          if (id.trim()) used.add(id.trim())
        }
      }
    }
  }
  return used
}

export function collectFlatPlanReferenceIds(
  tasks: Array<{ referenceIds?: string[] | undefined }>
): Set<string> {
  const used = new Set<string>()
  for (const task of tasks) {
    for (const id of task.referenceIds ?? []) {
      if (id.trim()) used.add(id.trim())
    }
  }
  return used
}

export function validateTaskReferenceIds(
  manifest: JobReferenceManifest,
  referenceIds: string[]
): string[] {
  const available = new Set(manifest.references.map((item) => item.id))
  const errors: string[] = []
  for (const id of referenceIds) {
    if (!available.has(id)) {
      errors.push(`unknown referenceId "${id}"`)
    }
  }
  return errors
}

export function validateReferenceCoverage(
  usedReferenceIds: Set<string>,
  manifest: JobReferenceManifest
): string[] {
  const ignored = new Set(manifest.ignoredReferenceIds)
  const errors: string[] = []

  for (const entry of manifest.references) {
    if (ignored.has(entry.id) || entry.excludedFromCoverage) continue
    if (!entry.requiresDescription) continue
    if (!usedReferenceIds.has(entry.id)) {
      errors.push(`reference "${entry.name}" (${entry.id}) is not assigned to any task`)
    }
  }

  return errors
}

export function resolveAssignedReferences(
  manifest: JobReferenceManifest,
  referenceIds: string[]
): JobReferenceEntry[] {
  const byId = new Map(manifest.references.map((item) => [item.id, item]))
  const resolved: JobReferenceEntry[] = []
  for (const id of referenceIds) {
    const entry = byId.get(id)
    if (entry) resolved.push(entry)
  }
  return resolved
}

export function resolveAssignedReferencesFromDto(
  manifest: JobReferenceManifestDto | null | undefined,
  referenceIds: string[]
): TaskAssignedReference[] {
  if (!manifest?.references.length || referenceIds.length === 0) return []
  const byId = new Map(manifest.references.map((item) => [item.id, item]))
  const resolved: TaskAssignedReference[] = []
  for (const id of referenceIds) {
    const entry = byId.get(id)
    if (!entry) continue
    resolved.push({
      id: entry.id,
      name: entry.name,
      kind: entry.kind,
      description: entry.description,
      thumbnailUrl: entry.assetUrl || undefined
    })
  }
  return resolved
}

export function toTaskAssignedReferences(entries: JobReferenceEntry[]): TaskAssignedReference[] {
  return entries.map((entry) => ({
    id: entry.id,
    name: entry.name,
    kind: entry.kind,
    description: entry.description,
    thumbnailUrl: entry.assetUrl || undefined
  }))
}
