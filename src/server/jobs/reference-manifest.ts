import { resolveAttachmentRelativePath } from '../conversation/attachments'
import { getAppContext } from '../bootstrap'
import type { TaskLaunchDraftReference } from '../conversation/draft/types'
import { getDb } from '../db'
import { threadJobs } from '../db/schema'
import { eq } from 'drizzle-orm'
import { mergeDraftReferences, loadJobDraftReferences } from './draft-references'
import type { TaskLaunchDraftPayload } from '../conversation/draft/types'
import { referenceRequiresDescription } from '@shared/draft-references'
import {
  buildJobReferenceManifest,
  parseJobReferenceManifest,
  resolveAssignedReferences,
  toPublicReferenceManifest,
  type JobReferenceManifest,
  type JobReferenceManifestDto
} from '@shared/job-references'
import {
  assertLocalCorpusFileAllowed,
  inferReferenceKind,
  pathInWorkspace,
  resolveAttachmentAbsolutePath,
  resolveLocalCorpusPath
} from '../reference-corpus/paths'
import {
  assertManifestReferenceFilesExist as assertManifestReferenceFilesExistOnDisk,
  ReferenceFileMissingError,
  resolveAssignedReferenceLocalPaths as resolveAssignedReferenceLocalPathsOnDisk,
  resolveReferenceAbsolutePath as resolveReferenceAbsolutePathOnDisk
} from './reference-paths'

export { ReferenceFileMissingError }

export function resolveReferenceRelativePath(
  threadId: string,
  ref: Pick<TaskLaunchDraftReference, 'id' | 'name' | 'mimeType'>
): string {
  const relativePath = resolveAttachmentRelativePath(threadId, ref.id)
  if (!relativePath) {
    throw new ReferenceFileMissingError(ref.id, ref.name)
  }
  return relativePath
}

export function assertManifestReferenceFilesExist(
  threadId: string,
  manifest: JobReferenceManifest,
  dataDir = getAppContext().dataDir
): void {
  assertManifestReferenceFilesExistOnDisk(dataDir, threadId, manifest)
}

export function resolveAssignedReferenceLocalPaths(
  manifest: JobReferenceManifest,
  referenceIds: string[],
  threadId: string,
  dataDir = getAppContext().dataDir
): Map<string, string> {
  return resolveAssignedReferenceLocalPathsOnDisk(dataDir, threadId, manifest, referenceIds)
}

export function resolveReferenceAbsolutePath(
  threadId: string,
  relativePath: string,
  dataDir = getAppContext().dataDir
): string {
  return resolveReferenceAbsolutePathOnDisk(dataDir, threadId, relativePath)
}

function resolveDraftReferencePaths(input: {
  threadId: string
  workspaceRoot: string
  ref: TaskLaunchDraftReference & { source?: string; localPath?: string; kind?: string }
  dataDir: string
}): {
  relativePath?: string
  resolvedPath: string
  inWorkspace: boolean
  source: 'attachment' | 'local_corpus'
  kind: 'file' | 'directory' | 'image'
} {
  const source =
    input.ref.source === 'local_corpus' ? ('local_corpus' as const) : ('attachment' as const)

  if (source === 'local_corpus') {
    if (!input.ref.localPath?.trim()) {
      throw new ReferenceFileMissingError(input.ref.id, input.ref.name)
    }
    const resolvedPath = resolveLocalCorpusPath(input.ref.localPath)
    const inferred = inferReferenceKind(resolvedPath)
    const kind =
      input.ref.kind === 'directory'
        ? 'directory'
        : inferred === 'directory'
          ? 'directory'
          : input.ref.kind === 'image'
            ? 'image'
            : 'file'
    if (kind === 'file') {
      assertLocalCorpusFileAllowed('file')
    }
    return {
      resolvedPath,
      inWorkspace: pathInWorkspace(resolvedPath, input.workspaceRoot),
      source,
      kind
    }
  }

  const relativePath = resolveReferenceRelativePath(input.threadId, input.ref)
  const resolvedPath = resolveAttachmentAbsolutePath(input.dataDir, input.threadId, relativePath)
  return {
    relativePath,
    resolvedPath,
    inWorkspace: pathInWorkspace(resolvedPath, input.workspaceRoot),
    source,
    kind: input.ref.kind === 'image' ? 'image' : 'file'
  }
}

export function buildManifestFromDraft(input: {
  jobId: string
  threadId: string
  workspaceRoot: string
  payload: TaskLaunchDraftPayload
  ignoredReferenceIds?: string[]
  manifestRevision?: number
}): JobReferenceManifest {
  const dataDir = getAppContext().dataDir
  const references = mergeDraftReferences(input.payload).map((ref) => {
    const paths = resolveDraftReferencePaths({
      threadId: input.threadId,
      workspaceRoot: input.workspaceRoot,
      ref: ref as TaskLaunchDraftReference & { source?: string; localPath?: string; kind?: string },
      dataDir
    })
    return {
      id: ref.id,
      name: ref.name,
      kind: paths.kind,
      mimeType: ref.mimeType,
      description: ref.description,
      relativePath: paths.relativePath,
      resolvedPath: paths.resolvedPath,
      source: paths.source,
      inWorkspace: paths.inWorkspace,
      assetUrl: ref.assetUrl,
      requiresDescription: referenceRequiresDescription(ref)
    }
  })
  const manifest = buildJobReferenceManifest({
    jobId: input.jobId,
    threadId: input.threadId,
    references,
    ignoredReferenceIds: input.ignoredReferenceIds
  })
  assertManifestReferenceFilesExist(input.threadId, manifest)
  return {
    ...manifest,
    designSessionId: input.jobId.startsWith('ds-') ? input.jobId : undefined,
    manifestRevision: input.manifestRevision ?? 0
  }
}

export async function loadJobReferenceManifest(
  jobId: string
): Promise<JobReferenceManifest | null> {
  const db = getDb()
  const rows = await db.select().from(threadJobs).where(eq(threadJobs.id, jobId)).limit(1)
  const row = rows[0]
  if (!row) return null

  const parsed = parseJobReferenceManifest(row.referenceManifestJson)
  if (parsed) return parsed
  return null
}

export async function loadJobReferenceManifestForJob(input: {
  jobId: string
  threadId: string
  draftMessageId: string
  username: string
  workspaceRoot?: string
}): Promise<JobReferenceManifest | null> {
  const fromDb = await loadJobReferenceManifest(input.jobId)
  if (fromDb) return fromDb

  const draftRefs = await loadJobDraftReferences(input.username, {
    threadId: input.threadId,
    draftMessageId: input.draftMessageId
  })
  if (draftRefs.length === 0) return null

  const workspaceRoot = input.workspaceRoot ?? ''
  const manifest = buildJobReferenceManifest({
    jobId: input.jobId,
    threadId: input.threadId,
    references: draftRefs.map((ref) => {
      const paths = resolveDraftReferencePaths({
        threadId: input.threadId,
        workspaceRoot,
        ref: ref as TaskLaunchDraftReference & {
          source?: string
          localPath?: string
          kind?: string
        },
        dataDir: getAppContext().dataDir
      })
      return {
        id: ref.id,
        name: ref.name,
        kind: paths.kind,
        mimeType: ref.mimeType,
        description: ref.description,
        relativePath: paths.relativePath,
        resolvedPath: paths.resolvedPath,
        source: paths.source,
        inWorkspace: paths.inWorkspace,
        assetUrl: ref.assetUrl,
        requiresDescription: referenceRequiresDescription(ref)
      }
    })
  })
  if (workspaceRoot) {
    assertManifestReferenceFilesExist(input.threadId, manifest)
  }
  return manifest
}

export async function loadPublicJobReferenceManifest(input: {
  jobId: string
  threadId: string
  draftMessageId: string
  username: string
}): Promise<JobReferenceManifestDto | null> {
  const manifest = await loadJobReferenceManifestForJob(input)
  return manifest ? toPublicReferenceManifest(manifest) : null
}

export function serializeJobReferenceManifest(manifest: JobReferenceManifest): string {
  return JSON.stringify(manifest)
}

export { resolveAssignedReferences }
