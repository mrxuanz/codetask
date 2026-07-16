import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { changeSetRootPath, changeSetWorktreePath } from './paths'

const SKIP_DIR_NAMES = new Set([
  '.git',
  'node_modules',
  '.codegraph',
  'dist',
  'out',
  'coverage',
  '.turbo',
  '.next'
])

export function changeSetBaseMirrorPath(dataDir: string, changeSetId: string): string {
  return join(changeSetRootPath(dataDir, changeSetId), 'base')
}

export function changeSetCowPatchPath(dataDir: string, changeSetId: string): string {
  return join(changeSetRootPath(dataDir, changeSetId), 'patch.json')
}

function shouldSkipDir(name: string): boolean {
  return SKIP_DIR_NAMES.has(name)
}

function walkFiles(root: string, dir: string, out: string[]): void {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const name of entries) {
    if (shouldSkipDir(name)) continue
    const absolute = join(dir, name)
    let st
    try {
      st = lstatSync(absolute)
    } catch {
      continue
    }
    if (st.isSymbolicLink()) continue
    if (st.isDirectory()) {
      walkFiles(root, absolute, out)
      continue
    }
    if (st.isFile()) {
      out.push(absolute)
    }
  }
}

function relPosix(root: string, absolute: string): string {
  return relative(root, absolute).split(sep).join('/')
}

export function fingerprintWorkspaceTree(workspaceRoot: string): string {
  const files: string[] = []
  walkFiles(workspaceRoot, workspaceRoot, files)
  files.sort()
  const hash = createHash('sha256')
  for (const absolute of files) {
    const rel = relPosix(workspaceRoot, absolute)
    const content = readFileSync(absolute)
    const fileHash = createHash('sha256').update(content).digest('hex')
    hash.update(`${rel}=${fileHash}\n`)
  }
  return hash.digest('hex')
}

function copyTree(srcRoot: string, destRoot: string): void {
  mkdirSync(destRoot, { recursive: true })
  const files: string[] = []
  walkFiles(srcRoot, srcRoot, files)
  for (const absolute of files) {
    const rel = relative(srcRoot, absolute)
    const dest = join(destRoot, rel)
    mkdirSync(dirname(dest), { recursive: true })
    copyFileSync(absolute, dest)
  }
}

/**
 * Non-git prepare: mirror workspace into base/ + worktree/ under the Change Set root.
 * base fingerprint is stored by the caller as baseCommit/baseWorkspaceGeneration.
 */
export function prepareNonGitCowWorktree(input: {
  dataDir: string
  changeSetId: string
  workspaceRoot: string
}): { worktreePath: string; baseFingerprint: string } {
  const root = changeSetRootPath(input.dataDir, input.changeSetId)
  const basePath = changeSetBaseMirrorPath(input.dataDir, input.changeSetId)
  const worktreePath = changeSetWorktreePath(input.dataDir, input.changeSetId)

  if (existsSync(root)) {
    rmSync(root, { recursive: true, force: true })
  }
  mkdirSync(root, { recursive: true })

  const baseFingerprint = fingerprintWorkspaceTree(input.workspaceRoot)
  copyTree(input.workspaceRoot, basePath)
  copyTree(input.workspaceRoot, worktreePath)
  const afterCopyFingerprint = fingerprintWorkspaceTree(input.workspaceRoot)
  if (afterCopyFingerprint !== baseFingerprint) {
    rmSync(root, { recursive: true, force: true })
    throw new Error('Workspace changed while creating the isolated snapshot; retry the turn')
  }

  return { worktreePath, baseFingerprint }
}

export interface CowFileChange {
  path: string
  kind: 'modify' | 'add' | 'delete'
  contentBase64?: string
}

export interface CowPatchArtifact {
  patchPath: string
  patchHash: string
  changes: CowFileChange[]
  empty: boolean
}

function fileMap(root: string): Map<string, string> {
  const files: string[] = []
  walkFiles(root, root, files)
  const map = new Map<string, string>()
  for (const absolute of files) {
    const rel = relPosix(root, absolute)
    map.set(rel, createHash('sha256').update(readFileSync(absolute)).digest('hex'))
  }
  return map
}

export function buildCowPatch(input: { dataDir: string; changeSetId: string }): CowPatchArtifact {
  const basePath = changeSetBaseMirrorPath(input.dataDir, input.changeSetId)
  const worktreePath = changeSetWorktreePath(input.dataDir, input.changeSetId)
  if (!existsSync(basePath) || !existsSync(worktreePath)) {
    throw new Error('COW base/worktree missing')
  }

  const base = fileMap(basePath)
  const work = fileMap(worktreePath)
  const changes: CowFileChange[] = []

  for (const [path, hash] of work) {
    const prev = base.get(path)
    if (prev === hash) continue
    const absolute = join(worktreePath, path)
    changes.push({
      path,
      kind: prev ? 'modify' : 'add',
      contentBase64: readFileSync(absolute).toString('base64')
    })
  }
  for (const path of base.keys()) {
    if (!work.has(path)) {
      changes.push({ path, kind: 'delete' })
    }
  }

  const patchPath = changeSetCowPatchPath(input.dataDir, input.changeSetId)
  const body = JSON.stringify({ version: 1, changes }, null, 2)
  const storedBody = `${body}\n`
  writeFileSync(patchPath, storedBody, 'utf8')
  const patchHash = createHash('sha256').update(storedBody).digest('hex')
  return { patchPath, patchHash, changes, empty: changes.length === 0 }
}

export function readCowPatch(dataDir: string, changeSetId: string): CowFileChange[] | null {
  const patchPath = changeSetCowPatchPath(dataDir, changeSetId)
  if (!existsSync(patchPath)) return null
  try {
    const parsed = JSON.parse(readFileSync(patchPath, 'utf8')) as {
      changes?: CowFileChange[]
    }
    if (!Array.isArray(parsed.changes)) return null
    const valid = parsed.changes.every(
      (change) =>
        change !== null &&
        typeof change === 'object' &&
        typeof change.path === 'string' &&
        (change.kind === 'modify' || change.kind === 'add' || change.kind === 'delete') &&
        (change.contentBase64 === undefined || typeof change.contentBase64 === 'string')
    )
    return valid ? parsed.changes : null
  } catch {
    return null
  }
}

function resolveContainedFile(root: string, path: string): string {
  if (!path || isAbsolute(path) || path.includes('\0')) {
    throw new Error(`Invalid COW patch path: ${path}`)
  }
  const absolute = resolve(root, path)
  const rel = relative(resolve(root), absolute)
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`COW patch path escapes worktree: ${path}`)
  }

  let cursor = resolve(root)
  const parts = rel.split(sep)
  for (const part of parts) {
    cursor = join(cursor, part)
    if (!existsSync(cursor)) continue
    if (lstatSync(cursor).isSymbolicLink()) {
      throw new Error(`COW patch path crosses symlink: ${path}`)
    }
  }
  return absolute
}

function fileHash(path: string): string | null {
  if (!existsSync(path)) return null
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink()) return null
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

export function cowPatchConflictsWithWorkspace(input: {
  dataDir: string
  changeSetId: string
  workspaceRoot: string
  changes: CowFileChange[]
}): boolean {
  const basePath = changeSetBaseMirrorPath(input.dataDir, input.changeSetId)
  return input.changes.some((change) => {
    const base = resolveContainedFile(basePath, change.path)
    const current = resolveContainedFile(input.workspaceRoot, change.path)
    const baseHash = fileHash(base)
    const currentHash = fileHash(current)
    if (change.kind === 'add') return currentHash !== null
    return baseHash === null || baseHash !== currentHash
  })
}

/** Apply the user's COW patch to a newly prepared isolated worktree, never to main. */
export function applyCowChangesToWorktree(worktreePath: string, changes: CowFileChange[]): void {
  for (const change of changes) {
    const absolute = resolveContainedFile(worktreePath, change.path)
    if (change.kind === 'delete') {
      if (existsSync(absolute)) rmSync(absolute, { force: true })
      continue
    }
    if (!change.contentBase64) throw new Error(`COW patch content missing: ${change.path}`)
    mkdirSync(dirname(absolute), { recursive: true })
    writeFileSync(absolute, Buffer.from(change.contentBase64, 'base64'))
  }
}

export type CowApplyResult =
  | { kind: 'applied' }
  | { kind: 'needs_resolution'; reason: 'base_changed' | 'apply_conflict' | 'empty_patch' }

export function applyCowPatchToMainWorkspace(input: {
  workspaceRoot: string
  baseFingerprint: string | null
  changes: CowFileChange[]
}): CowApplyResult {
  if (!input.changes.length) {
    return { kind: 'needs_resolution', reason: 'empty_patch' }
  }
  if (input.baseFingerprint) {
    const current = fingerprintWorkspaceTree(input.workspaceRoot)
    if (current !== input.baseFingerprint) {
      return { kind: 'needs_resolution', reason: 'base_changed' }
    }
  }

  try {
    for (const change of input.changes) {
      const absolute = resolveContainedFile(input.workspaceRoot, change.path)
      if (change.kind === 'delete') {
        if (existsSync(absolute)) rmSync(absolute, { force: true })
        continue
      }
      if (!change.contentBase64) {
        return { kind: 'needs_resolution', reason: 'apply_conflict' }
      }
      mkdirSync(dirname(absolute), { recursive: true })
      writeFileSync(absolute, Buffer.from(change.contentBase64, 'base64'))
    }
    return { kind: 'applied' }
  } catch {
    return { kind: 'needs_resolution', reason: 'apply_conflict' }
  }
}
