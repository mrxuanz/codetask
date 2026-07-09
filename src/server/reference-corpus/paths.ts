import { existsSync, lstatSync, realpathSync } from 'fs'
import { homedir } from 'os'
import { isAbsolute, join, resolve, sep } from 'path'
import { threadAttachmentsDir } from '../data-paths'
import { cleanDisplayPath } from '../fs/index'
import { detectSandboxReadCapabilities } from './sandbox-capabilities'

export class ReferencePathError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ReferencePathError'
  }
}

function expandTildePath(input: string): string {
  const trimmed = cleanDisplayPath(input.trim())
  if (trimmed === '~') {
    const home = process.env.USERPROFILE || homedir()
    if (!home) throw new ReferencePathError('Unable to resolve user home directory')
    return home
  }
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    const home = process.env.USERPROFILE || homedir()
    if (!home) throw new ReferencePathError('Unable to resolve user home directory')
    return join(home, trimmed.slice(2))
  }
  return trimmed
}

export function resolveLocalCorpusPath(localPath: string): string {
  const trimmed = localPath.trim()
  if (!trimmed) {
    throw new ReferencePathError('localPath is required')
  }

  const expanded = expandTildePath(trimmed)
  if (!isAbsolute(expanded)) {
    throw new ReferencePathError('localPath must be an absolute path')
  }

  let candidate: string
  try {
    candidate = resolve(expanded)
  } catch {
    throw new ReferencePathError(`Invalid path: ${localPath}`)
  }

  if (!existsSync(candidate)) {
    throw new ReferencePathError(`Path does not exist or is unreadable: ${localPath}`)
  }

  let resolved: string
  try {
    resolved = realpathSync(candidate)
  } catch {
    throw new ReferencePathError(`Unable to resolve path: ${localPath}`)
  }

  try {
    lstatSync(resolved)
  } catch {
    throw new ReferencePathError(`Path is inaccessible: ${localPath}`)
  }

  return cleanDisplayPath(resolved)
}

export function inferReferenceKind(resolvedPath: string): 'file' | 'directory' {
  const stat = lstatSync(resolvedPath)
  return stat.isDirectory() ? 'directory' : 'file'
}

export function pathInWorkspace(resolvedPath: string, workspaceRoot: string): boolean {
  const workspace = realpathSync(resolve(workspaceRoot))
  const prefix = workspace.endsWith(sep) ? workspace : `${workspace}${sep}`
  return resolvedPath === workspace || resolvedPath.startsWith(prefix)
}

export function assertLocalCorpusFileAllowed(kind: 'file' | 'directory'): void {
  if (kind !== 'file') return
  const caps = detectSandboxReadCapabilities()
  if (!caps.singleFileAllowlist) {
    throw new ReferencePathError(
      'This sandbox only supports directory-level local corpus reads. Set kind to directory or choose a corpus directory instead of a single file.'
    )
  }
}

export function resolveAttachmentAbsolutePath(
  dataDir: string,
  threadId: string,
  relativePath: string
): string {
  const attachmentsDir = threadAttachmentsDir(dataDir, threadId)
  const candidate = resolve(attachmentsDir, relativePath)
  if (!existsSync(candidate)) {
    throw new ReferencePathError(`Attachment not found: ${relativePath}`)
  }

  const root = existsSync(attachmentsDir) ? realpathSync(attachmentsDir) : resolve(attachmentsDir)
  const real = realpathSync(candidate)
  if (real !== root && !real.startsWith(root + sep)) {
    throw new ReferencePathError(`Attachment path out of bounds: ${relativePath}`)
  }
  return real
}
