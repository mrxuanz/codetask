import { existsSync, realpathSync } from 'fs'
import { dirname } from 'path'
import { join } from 'path'
import { getAppContext } from '../bootstrap'
import type { JobReferenceManifest } from '@shared/job-references'
import type { TaskLaunchDraftPayload } from '../conversation/draft/types'
import {
  resolveAttachmentRelativePath,
  resolveTurnAttachmentReadRoots
} from '../conversation/attachments'
import { resolveAttachmentAbsolutePath, resolveLocalCorpusPath } from '../reference-corpus/paths'
import { projectTaskReadGrants, readGrantsToReadRoots } from '../reference-corpus/read-grants'

export function resolveTaskReferenceReadRoots(input: {
  workspaceRoot: string
  manifest: JobReferenceManifest
  taskReferenceIds: string[]
}): string[] {
  if (input.taskReferenceIds.length === 0) return []
  const grants = projectTaskReadGrants({
    workspaceRoot: input.workspaceRoot,
    manifest: input.manifest,
    taskReferenceIds: input.taskReferenceIds
  })
  return readGrantsToReadRoots(grants)
}

export function resolveThreadAttachmentReadRoot(
  threadId: string,
  dataDir = getAppContext().dataDir
): string | null {
  const dir = join(dataDir, 'attachments', threadId)
  if (!existsSync(dir)) return null
  try {
    return realpathSync(dir)
  } catch {
    return dir
  }
}

export function resolveReferenceManifestReadRoots(input: {
  workspaceRoot: string
  manifest: JobReferenceManifest
  referenceIds?: string[]
}): string[] {
  const referenceIds = input.referenceIds ?? input.manifest.references.map((item) => item.id)
  if (referenceIds.length === 0) return []
  return resolveTaskReferenceReadRoots({
    workspaceRoot: input.workspaceRoot,
    manifest: input.manifest,
    taskReferenceIds: referenceIds
  })
}

export function resolveDraftReferenceReadRoots(input: {
  threadId: string
  draft: Pick<TaskLaunchDraftPayload, 'references' | 'sourceAttachments'>
  dataDir?: string
}): string[] {
  const dataDir = input.dataDir ?? getAppContext().dataDir
  const attachmentRoots = resolveTurnAttachmentReadRoots({
    threadId: input.threadId,
    attachments: input.draft.sourceAttachments ?? [],
    dataDir
  })
  const roots = [...attachmentRoots]
  const seen = new Set(roots.map((root) => root.toLowerCase()))

  const addRoot = (root: string): void => {
    const key = root.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    roots.push(root)
  }

  for (const ref of input.draft.references) {
    if (ref.source === 'local_corpus' && ref.localPath?.trim()) {
      try {
        const resolvedPath = resolveLocalCorpusPath(ref.localPath)
        addRoot(ref.kind === 'directory' ? resolvedPath : dirname(resolvedPath))
      } catch {
        // ignore
      }
      continue
    }

    const relativePath = resolveAttachmentRelativePath(input.threadId, ref.id)
    if (!relativePath) continue
    try {
      const absolutePath = resolveAttachmentAbsolutePath(dataDir, input.threadId, relativePath)
      addRoot(dirname(absolutePath))
    } catch {
      // ignore
    }
  }

  return roots
}

export function buildAssignedReferenceCorpusMarkdown(input: {
  manifest: JobReferenceManifest
  referenceIds: string[]
  referenceReason?: string
  localPathById?: ReadonlyMap<string, string>
}): string {
  if (input.referenceIds.length === 0) return ''

  const byId = new Map(input.manifest.references.map((item) => [item.id, item]))
  const lines = [
    '## Assigned Reference Corpus',
    'Use these materials when implementing this task. Reference files are read-only; do not modify them.',
    ''
  ]

  if (input.referenceReason?.trim()) {
    lines.push(`Planner note: ${input.referenceReason.trim()}`, '')
  }

  for (const id of input.referenceIds) {
    const ref = byId.get(id)
    if (!ref) {
      lines.push(`- id: ${id} (missing from manifest — do not invent content)`)
      continue
    }
    const localPath = input.localPathById?.get(id) ?? ref.resolvedPath
    lines.push(
      `- id: ${id}`,
      `  source: ${ref.source ?? 'attachment'}`,
      `  name: ${ref.name}`,
      `  kind: ${ref.kind ?? 'file'}`,
      `  inWorkspace: ${ref.inWorkspace ?? false}`,
      `  description: ${ref.description?.trim() || '(no description)'}`
    )
    if (localPath) {
      lines.push(`  resolvedPath: ${localPath}`)
    }
  }

  return lines.join('\n')
}
