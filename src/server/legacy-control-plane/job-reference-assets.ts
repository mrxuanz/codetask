import { randomUUID } from 'crypto'
import { copyFile, mkdir, realpath, rm, stat } from 'fs/promises'
import { basename, join } from 'path'
import type { JobReferenceManifest } from '@shared/job-references'
import { getAppContext } from '../bootstrap'
import { attachmentDir } from '../data-paths'
import { ReferenceFileMissingError, resolveReferenceAbsolutePath } from './reference-paths'

export interface JobReferenceAssetTransfer {
  referenceId: string
  attachmentId: string
  relativePath: string
  resolvedPath: string
  assetUrl: string
}

export interface StagedJobReferenceAssets {
  manifest: JobReferenceManifest
  transfers: JobReferenceAssetTransfer[]
  cleanup(): Promise<void>
}

function safeFilename(name: string): string {
  const base = basename(name.trim() || 'file')
  return base.replace(/[^\w.\-()+@]/g, '_') || 'file'
}

/**
 * Copy every draft-owned attachment into a fresh Job-owned physical asset.
 * The returned copies are not authoritative until their manifest is committed with
 * the launch CAS; callers must invoke cleanup when that commit does not succeed.
 */
export async function stageJobReferenceAssets(input: {
  jobId: string
  sourceThreadId: string
  targetThreadId: string
  manifest: JobReferenceManifest
}): Promise<StagedJobReferenceAssets> {
  const dataDir = getAppContext().dataDir
  const transfers: JobReferenceAssetTransfer[] = []
  const createdAttachmentIds: string[] = []

  try {
    for (const entry of input.manifest.references) {
      if ((entry.source ?? 'attachment') !== 'attachment') continue

      if (!entry.relativePath) {
        throw new ReferenceFileMissingError(entry.id, entry.name)
      }
      // Resolve attachment sources through the thread attachment root even when a
      // persisted manifest also contains an absolute resolvedPath.
      const sourcePath = resolveReferenceAbsolutePath(
        dataDir,
        input.sourceThreadId,
        entry.relativePath
      )
      const sourceStat = await stat(sourcePath)
      if (!sourceStat.isFile()) {
        throw new Error(`Attachment reference is not a file: ${entry.id}`)
      }

      const attachmentId = `att-${randomUUID()}`
      const filename = safeFilename(entry.name || basename(sourcePath))
      const destinationDir = attachmentDir(dataDir, input.targetThreadId, attachmentId)
      const destinationPath = join(destinationDir, filename)
      await mkdir(destinationDir, { recursive: true })
      createdAttachmentIds.push(attachmentId)
      await copyFile(sourcePath, destinationPath)

      transfers.push({
        referenceId: entry.id,
        attachmentId,
        relativePath: `${attachmentId}/${filename}`,
        resolvedPath: await realpath(destinationPath),
        assetUrl: `/api/threads/${encodeURIComponent(input.targetThreadId)}/attachments/${encodeURIComponent(attachmentId)}`
      })
    }
  } catch (error) {
    await Promise.all(
      createdAttachmentIds.map((attachmentId) =>
        rm(attachmentDir(dataDir, input.targetThreadId, attachmentId), {
          recursive: true,
          force: true
        }).catch(() => undefined)
      )
    )
    throw error
  }

  const transferByReferenceId = new Map(
    transfers.map((transfer) => [transfer.referenceId, transfer])
  )
  const manifest: JobReferenceManifest = {
    ...input.manifest,
    jobId: input.jobId,
    frozenAt: new Date().toISOString(),
    references: input.manifest.references.map((entry) => {
      const transfer = transferByReferenceId.get(entry.id)
      if (!transfer) {
        return {
          ...entry,
          storageOwner:
            entry.storageOwner ??
            ((entry.source ?? 'attachment') === 'local_corpus' ? 'external' : 'draft')
        }
      }
      return {
        ...entry,
        relativePath: transfer.relativePath,
        resolvedPath: transfer.resolvedPath,
        assetUrl: transfer.assetUrl,
        inWorkspace: false,
        storageOwner: 'job' as const,
        attachmentId: transfer.attachmentId
      }
    })
  }

  return {
    manifest,
    transfers,
    cleanup: async () => {
      await Promise.all(
        transfers.map((transfer) =>
          rm(attachmentDir(dataDir, input.targetThreadId, transfer.attachmentId), {
            recursive: true,
            force: true
          })
        )
      )
    }
  }
}
