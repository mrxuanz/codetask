import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import type {
  DraftAssetStore,
  DraftAttachmentRecord,
  StagedJobIntakeAsset,
  StagedJobIntakeAssets,
  StoredDraftAsset
} from '../../core/application/ports'
import { DraftError } from '../../core/domain/draft'

function safeSegment(value: string, field: string): string {
  if (!value || value === '.' || value === '..' || /[\\/\0]/.test(value)) {
    throw new DraftError('draft.asset_path_invalid', { field })
  }
  return value
}

function safeFilename(value: string): string {
  const name = basename(value).replace(/[^\p{L}\p{N}._()+@ -]/gu, '_')
  if (!name || name === '.' || name === '..') return 'attachment'
  return name.slice(0, 240)
}

function resolveInside(root: string, relativePath: string): string {
  const absoluteRoot = resolve(root)
  const target = resolve(absoluteRoot, relativePath)
  const child = relative(absoluteRoot, target)
  if (!child || child === '..' || child.startsWith(`..${sep}`) || child.startsWith('/')) {
    throw new DraftError('draft.asset_path_invalid')
  }
  return target
}

async function sha256(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
}

export class FileSystemDraftAssetStore implements DraftAssetStore {
  constructor(
    private readonly draftRoot: string,
    private readonly jobIntakeRoot: string
  ) {}

  async storeDraftAttachment(input: {
    readonly draftId: string
    readonly attachmentId: string
    readonly displayName: string
    readonly bytes: Uint8Array
  }): Promise<StoredDraftAsset> {
    const storageRelativePath = join(
      safeSegment(input.draftId, 'draftId'),
      safeSegment(input.attachmentId, 'attachmentId'),
      safeFilename(input.displayName)
    )
    const absolutePath = resolveInside(this.draftRoot, storageRelativePath)
    await mkdir(dirname(absolutePath), { recursive: true })
    try {
      await writeFile(absolutePath, input.bytes, { flag: 'wx' })
    } catch (error) {
      await rm(dirname(absolutePath), { recursive: true, force: true }).catch(() => undefined)
      throw error
    }
    return { storageRelativePath, absolutePath }
  }

  resolveDraftAttachment(storageRelativePath: string): string {
    return resolveInside(this.draftRoot, storageRelativePath)
  }

  async removeDraftAttachment(storageRelativePath: string): Promise<void> {
    await rm(dirname(this.resolveDraftAttachment(storageRelativePath)), {
      recursive: true,
      force: true
    })
  }

  async removeDraft(draftId: string): Promise<void> {
    await rm(resolveInside(this.draftRoot, safeSegment(draftId, 'draftId')), {
      recursive: true,
      force: true
    })
  }

  async stageJobIntakeAssets(input: {
    readonly handoffId: string
    readonly attachments: readonly DraftAttachmentRecord[]
  }): Promise<StagedJobIntakeAssets> {
    const handoffId = safeSegment(input.handoffId, 'handoffId')
    const handoffRoot = resolveInside(this.jobIntakeRoot, handoffId)
    const assets: StagedJobIntakeAsset[] = []
    try {
      for (const attachment of input.attachments) {
        const source = this.resolveDraftAttachment(attachment.storageRelativePath)
        const sourceStat = await stat(source)
        if (!sourceStat.isFile() || sourceStat.size !== attachment.sizeBytes) {
          throw new DraftError('draft.attachment_missing', { attachmentId: attachment.id })
        }
        if ((await sha256(source)) !== attachment.sha256) {
          throw new DraftError('draft.attachment_integrity_failed', {
            attachmentId: attachment.id
          })
        }
        const storageRelativePath = join(
          handoffId,
          safeSegment(attachment.id, 'attachmentId'),
          safeFilename(attachment.displayName)
        )
        const destination = resolveInside(this.jobIntakeRoot, storageRelativePath)
        await mkdir(dirname(destination), { recursive: true })
        await copyFile(source, destination)
        if ((await sha256(destination)) !== attachment.sha256) {
          throw new DraftError('draft.attachment_integrity_failed', {
            attachmentId: attachment.id
          })
        }
        assets.push({ sourceAttachment: attachment, storageRelativePath })
      }
    } catch (error) {
      await rm(handoffRoot, { recursive: true, force: true }).catch(() => undefined)
      throw error
    }
    return {
      assets,
      cleanup: () => rm(handoffRoot, { recursive: true, force: true })
    }
  }
}
