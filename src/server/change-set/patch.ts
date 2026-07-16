import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  applyCowPatchToMainWorkspace,
  buildCowPatch,
  readCowPatch,
  type CowApplyResult
} from './cow'
import { changeSetRootPath, isGitWorkspace, resolveGitHead } from './worktree'

export interface ChangeSetPatchArtifact {
  patchPath: string
  patchHash: string
  patchText: string
  empty: boolean
  kind: 'git' | 'cow'
}

export function changeSetPatchPath(dataDir: string, changeSetId: string): string {
  return join(changeSetRootPath(dataDir, changeSetId), 'patch.diff')
}

/**
 * Build a patch artifact from worktree edits.
 * Git worktrees → unified diff; non-git COW → patch.json (also mirrored as patchText JSON).
 */
export function buildChangeSetPatch(input: {
  dataDir: string
  changeSetId: string
  worktreePath: string
}): ChangeSetPatchArtifact {
  if (!existsSync(input.worktreePath)) {
    throw new Error(`Worktree missing: ${input.worktreePath}`)
  }

  if (isGitWorkspace(input.worktreePath)) {
    execFileSync('git', ['-C', input.worktreePath, 'add', '-A'], {
      encoding: 'utf8',
      windowsHide: true
    })

    let patchText = ''
    try {
      patchText = execFileSync('git', ['-C', input.worktreePath, 'diff', '--cached', '--binary'], {
        encoding: 'utf8',
        windowsHide: true,
        maxBuffer: 32 * 1024 * 1024
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`Failed to build change-set patch: ${message}`)
    }

    const root = changeSetRootPath(input.dataDir, input.changeSetId)
    mkdirSync(root, { recursive: true })
    const patchPath = changeSetPatchPath(input.dataDir, input.changeSetId)
    writeFileSync(patchPath, patchText, 'utf8')
    const patchHash = createHash('sha256').update(patchText).digest('hex')

    return {
      patchPath,
      patchHash,
      patchText,
      empty: patchText.trim().length === 0,
      kind: 'git'
    }
  }

  const cow = buildCowPatch({ dataDir: input.dataDir, changeSetId: input.changeSetId })
  return {
    patchPath: cow.patchPath,
    patchHash: cow.patchHash,
    patchText: JSON.stringify({ version: 1, changes: cow.changes }),
    empty: cow.empty,
    kind: 'cow'
  }
}

export function readStoredPatch(dataDir: string, changeSetId: string): string | null {
  const gitPath = changeSetPatchPath(dataDir, changeSetId)
  if (existsSync(gitPath)) {
    return readFileSync(gitPath, 'utf8')
  }
  const cow = readCowPatch(dataDir, changeSetId)
  if (!cow) return null
  return JSON.stringify({ version: 1, changes: cow })
}

/** Hash the exact persisted artifact so an out-of-band edit can never be applied silently. */
export function readStoredPatchHash(dataDir: string, changeSetId: string): string | null {
  const gitPath = changeSetPatchPath(dataDir, changeSetId)
  if (existsSync(gitPath)) {
    return createHash('sha256').update(readFileSync(gitPath)).digest('hex')
  }
  const cowPath = join(changeSetRootPath(dataDir, changeSetId), 'patch.json')
  if (!existsSync(cowPath)) return null
  return createHash('sha256').update(readFileSync(cowPath)).digest('hex')
}

export type ApplyPatchResult =
  | { kind: 'applied' }
  | {
      kind: 'needs_resolution'
      reason: 'base_changed' | 'apply_conflict' | 'non_git' | 'empty_patch'
    }
  | { kind: 'lease_busy' }

/**
 * Apply a stored patch to the main workspace under an already-held exclusive lease.
 */
export function applyPatchToMainWorkspace(input: {
  workspaceRoot: string
  baseCommit: string | null
  patchText: string
}): Exclude<ApplyPatchResult, { kind: 'lease_busy' }> {
  if (!input.patchText.trim()) {
    return { kind: 'needs_resolution', reason: 'empty_patch' }
  }

  if (isGitWorkspace(input.workspaceRoot)) {
    const currentHead = resolveGitHead(input.workspaceRoot)
    if (input.baseCommit && currentHead && input.baseCommit !== currentHead) {
      return { kind: 'needs_resolution', reason: 'base_changed' }
    }

    try {
      execFileSync('git', ['-C', input.workspaceRoot, 'apply', '--check', '--whitespace=nowarn'], {
        encoding: 'utf8',
        windowsHide: true,
        input: input.patchText,
        maxBuffer: 32 * 1024 * 1024
      })
      execFileSync('git', ['-C', input.workspaceRoot, 'apply', '--whitespace=nowarn'], {
        encoding: 'utf8',
        windowsHide: true,
        input: input.patchText,
        maxBuffer: 32 * 1024 * 1024
      })
      return { kind: 'applied' }
    } catch {
      return { kind: 'needs_resolution', reason: 'apply_conflict' }
    }
  }

  let changes
  try {
    const parsed = JSON.parse(input.patchText) as { changes?: unknown[] }
    if (
      !Array.isArray(parsed.changes) ||
      !parsed.changes.every(
        (change) =>
          change !== null &&
          typeof change === 'object' &&
          typeof (change as { path?: unknown }).path === 'string' &&
          ['modify', 'add', 'delete'].includes(String((change as { kind?: unknown }).kind ?? ''))
      )
    ) {
      return { kind: 'needs_resolution', reason: 'apply_conflict' }
    }
    changes = parsed.changes
  } catch {
    return { kind: 'needs_resolution', reason: 'apply_conflict' }
  }

  const cowResult: CowApplyResult = applyCowPatchToMainWorkspace({
    workspaceRoot: input.workspaceRoot,
    baseFingerprint: input.baseCommit,
    changes: changes as Parameters<typeof applyCowPatchToMainWorkspace>[0]['changes']
  })
  return cowResult
}
