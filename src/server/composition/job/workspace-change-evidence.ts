import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readlinkSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { assertWorkspaceRelativePath, JobError } from '../../core/domain/job'

const MAX_HASHED_FILE_BYTES = 16 * 1024 * 1024

export type DeclaredWorkspaceState = ReadonlyMap<string, string>

function resolveDeclaredPath(workspaceRoot: string, relativePath: string): string {
  assertWorkspaceRelativePath(relativePath)
  const root = resolve(workspaceRoot)
  const absolute = resolve(root, relativePath.replaceAll('\\', '/'))
  if (absolute !== root && !absolute.startsWith(`${root}${sep}`)) {
    throw new JobError('job.result_path_invalid', { path: relativePath })
  }
  return absolute
}

function pathSignature(absolutePath: string): string {
  try {
    const stat = lstatSync(absolutePath, { bigint: true })
    if (stat.isSymbolicLink()) {
      return `symlink:${readlinkSync(absolutePath)}`
    }
    if (stat.isFile()) {
      const metadata = `${stat.mode}:${stat.size}:${stat.mtimeNs}`
      if (stat.size > BigInt(MAX_HASHED_FILE_BYTES)) return `large-file:${metadata}`
      const sha256 = createHash('sha256').update(readFileSync(absolutePath)).digest('hex')
      return `file:${metadata}:${sha256}`
    }
    if (stat.isDirectory()) {
      return `directory:${stat.mode}:${stat.mtimeNs}`
    }
    return `other:${stat.mode}:${stat.size}:${stat.mtimeNs}`
  } catch (error) {
    const code =
      error instanceof Error && 'code' in error && typeof error.code === 'string'
        ? error.code
        : 'unknown'
    return code === 'ENOENT' ? 'missing' : `unreadable:${code}`
  }
}

export function captureDeclaredWorkspaceState(
  workspaceRoot: string,
  declaredFiles: readonly string[]
): DeclaredWorkspaceState {
  return new Map(
    [...new Set(declaredFiles)].map((relativePath) => [
      relativePath,
      pathSignature(resolveDeclaredPath(workspaceRoot, relativePath))
    ])
  )
}

export function recoverEmptyWorkReply(
  reply: string,
  before: DeclaredWorkspaceState,
  after: DeclaredWorkspaceState
): string {
  if (reply.trim()) return reply

  const changedFiles = [...after].flatMap(([relativePath, signature]) =>
    before.get(relativePath) === signature ? [] : [relativePath]
  )
  if (changedFiles.length === 0) throw new JobError('job.empty_result')

  return JSON.stringify({
    status: 'completed',
    summary:
      'The provider completed without a textual result. The server observed changes to declared workspace files; downstream verification remains authoritative.',
    changedFiles,
    evidence: changedFiles.map((relativePath) => `server-observed workspace change: ${relativePath}`)
  })
}
