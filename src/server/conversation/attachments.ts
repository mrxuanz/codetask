import { randomUUID } from 'crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'fs'
import { join, extname, basename, dirname } from 'path'
import { getAppContext } from '../bootstrap'
import { attachmentDir, threadAttachmentsDir } from '../data-paths'
import { resolveAttachmentAbsolutePath } from '../reference-corpus/paths'
import type { MessageAttachment } from './types'

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function initAttachmentStore(_dir: string): void {
  getAppContext()
}

function attachmentDataDir(): string {
  return getAppContext().dataDir
}

function attachmentsRoot(threadId: string): string {
  const root = threadAttachmentsDir(attachmentDataDir(), threadId)
  mkdirSync(root, { recursive: true })
  return root
}

function inferKind(mimeType: string): 'image' | 'file' {
  return mimeType.startsWith('image/') ? 'image' : 'file'
}

function safeFilename(name: string): string {
  const base = basename(name.trim() || 'file')
  return base.replace(/[^\w.\-()+@]/g, '_') || 'file'
}

function isolatedAttachmentDir(threadId: string, attachmentId: string): string {
  const dir = join(attachmentsRoot(threadId), attachmentId)
  mkdirSync(dir, { recursive: true })
  return dir
}

export function migrateFlatAttachmentIfNeeded(
  threadId: string,
  attachmentId: string
): string | null {
  const root = threadAttachmentsDir(attachmentDataDir(), threadId)
  if (!existsSync(root)) return null

  const isolatedDir = join(root, attachmentId)
  if (existsSync(isolatedDir)) {
    const files = readdirSync(isolatedDir)
    if (files.length > 0) return join(isolatedDir, files[0]!)
  }

  const flatFiles = readdirSync(root).filter(
    (file) =>
      file.startsWith(`${attachmentId}.`) || file === attachmentId || file === `${attachmentId}`
  )
  if (flatFiles.length === 0) return null

  mkdirSync(isolatedDir, { recursive: true })
  const src = join(root, flatFiles[0]!)
  const dest = join(isolatedDir, flatFiles[0]!)
  if (!existsSync(dest)) {
    try {
      renameSync(src, dest)
    } catch {
      const buffer = readFileSync(src)
      writeFileSync(dest, buffer)
    }
  }
  return dest
}

export function saveThreadAttachment(input: {
  threadId: string
  name: string
  mimeType: string
  buffer: Buffer
}): MessageAttachment {
  const id = `att-${randomUUID()}`
  const filename = safeFilename(input.name)
  const isolatedDir = isolatedAttachmentDir(input.threadId, id)
  const absolutePath = join(isolatedDir, filename)
  writeFileSync(absolutePath, input.buffer)
  const relativePath = `${id}/${filename}`

  return {
    id,
    name: input.name,
    mimeType: input.mimeType,
    sizeBytes: input.buffer.length,
    kind: inferKind(input.mimeType),
    relativePath,
    assetUrl: `/api/threads/${encodeURIComponent(input.threadId)}/attachments/${encodeURIComponent(id)}`
  }
}

export function resolveAttachmentRelativePath(
  threadId: string,
  attachmentId: string
): string | null {
  migrateFlatAttachmentIfNeeded(threadId, attachmentId)
  const isolatedDir = attachmentDir(attachmentDataDir(), threadId, attachmentId)
  if (existsSync(isolatedDir)) {
    const files = readdirSync(isolatedDir)
    if (files.length > 0) return `${attachmentId}/${files[0]!}`
  }
  const root = threadAttachmentsDir(attachmentDataDir(), threadId)
  if (!existsSync(root)) return null
  const match = readdirSync(root).find(
    (file) => file.startsWith(`${attachmentId}.`) || file === attachmentId
  )
  return match ?? null
}

export function readThreadAttachment(
  threadId: string,
  attachmentId: string
): {
  attachment: MessageAttachment
  buffer: Buffer
} | null {
  migrateFlatAttachmentIfNeeded(threadId, attachmentId)
  const relativePath = resolveAttachmentRelativePath(threadId, attachmentId)
  if (!relativePath) return null

  const absolutePath = join(threadAttachmentsDir(attachmentDataDir(), threadId), relativePath)
  if (!existsSync(absolutePath)) return null

  const buffer = readFileSync(absolutePath)
  const filename = basename(relativePath)
  const ext = extname(filename).toLowerCase()
  const mimeType =
    ext === '.png'
      ? 'image/png'
      : ext === '.jpg' || ext === '.jpeg'
        ? 'image/jpeg'
        : ext === '.webp'
          ? 'image/webp'
          : ext === '.gif'
            ? 'image/gif'
            : 'application/octet-stream'

  return {
    attachment: {
      id: attachmentId,
      name: filename,
      mimeType,
      sizeBytes: buffer.length,
      kind: inferKind(mimeType),
      relativePath,
      assetUrl: `/api/threads/${encodeURIComponent(threadId)}/attachments/${encodeURIComponent(attachmentId)}`
    },
    buffer
  }
}

export function resolveMessageAttachmentAbsolutePath(
  threadId: string,
  attachment: MessageAttachment,
  dataDir = attachmentDataDir()
): string | null {
  const relativePath = attachment.relativePath?.trim()
  if (!relativePath) return null
  try {
    return resolveAttachmentAbsolutePath(dataDir, threadId, relativePath)
  } catch {
    return null
  }
}

export function resolveTurnAttachmentReadRoots(input: {
  threadId: string
  attachments: MessageAttachment[]
  dataDir?: string
}): string[] {
  const dataDir = input.dataDir ?? attachmentDataDir()
  const roots: string[] = []
  const seen = new Set<string>()

  for (const attachment of input.attachments) {
    const absolutePath = resolveMessageAttachmentAbsolutePath(input.threadId, attachment, dataDir)
    if (!absolutePath) continue
    const isolatedDir = dirname(absolutePath)
    const key = isolatedDir.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    roots.push(isolatedDir)
  }

  return roots
}

export function buildAttachmentReferenceMarkdown(input: {
  threadId: string
  attachments: MessageAttachment[]
  dataDir?: string
}): string {
  if (input.attachments.length === 0) return ''
  const dataDir = input.dataDir ?? attachmentDataDir()
  const lines = [
    '## Reference Attachments',
    'Use the Read tool with the path below to inspect images and files. Attachment files are read-only.',
    ''
  ]
  for (const attachment of input.attachments) {
    lines.push(
      `- ${attachment.name} (id=${attachment.id}, kind=${attachment.kind}, mime=${attachment.mimeType})`
    )
    const absolutePath = resolveMessageAttachmentAbsolutePath(input.threadId, attachment, dataDir)
    if (absolutePath) {
      lines.push(`  path: ${absolutePath}`)
    }
  }
  return lines.join('\n')
}

export function resolveThreadAttachments(
  threadId: string,
  attachmentIds: string[]
): MessageAttachment[] {
  const resolved: MessageAttachment[] = []
  for (const attachmentId of attachmentIds) {
    const result = readThreadAttachment(threadId, attachmentId)
    if (result) resolved.push(result.attachment)
  }
  return resolved
}
