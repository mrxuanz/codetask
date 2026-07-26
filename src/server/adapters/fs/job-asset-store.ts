import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'
import type { JobAttachmentRecord } from '../../core/application/ports'
import { JobError } from '../../core/domain/job'

function resolveInside(root: string, storageRelativePath: string): string {
  const absoluteRoot = resolve(root)
  const target = resolve(absoluteRoot, storageRelativePath)
  const child = relative(absoluteRoot, target)
  if (!child || child === '..' || child.startsWith(`..${sep}`) || child.startsWith('/')) {
    throw new JobError('job.attachment_path_invalid')
  }
  return target
}

export class FileSystemJobAssetStore {
  constructor(private readonly root: string) {}

  async resolveVerified(
    attachment: JobAttachmentRecord
  ): Promise<JobAttachmentRecord & { readonly absolutePath: string }> {
    const absolutePath = resolveInside(this.root, attachment.storageRelativePath)
    const file = await stat(absolutePath).catch(() => null)
    if (!file?.isFile() || file.size !== attachment.sizeBytes) {
      throw new JobError('job.attachment_missing', {
        attachmentId: attachment.sourceAttachmentId
      })
    }
    const sha256 = createHash('sha256')
      .update(await readFile(absolutePath))
      .digest('hex')
    if (sha256 !== attachment.sha256) {
      throw new JobError('job.attachment_integrity_failed', {
        attachmentId: attachment.sourceAttachmentId
      })
    }
    return { ...attachment, absolutePath }
  }
}
