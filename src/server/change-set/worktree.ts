import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { prepareNonGitCowWorktree } from './cow'
import {
  changeSetRootPath,
  changeSetRuntimePath,
  changeSetWorktreePath
} from './paths'

export { changeSetRootPath, changeSetRuntimePath, changeSetWorktreePath }

export function isGitWorkspace(workspaceRoot: string): boolean {
  return existsSync(join(workspaceRoot, '.git'))
}

export function resolveGitHead(workspaceRoot: string): string | null {
  if (!isGitWorkspace(workspaceRoot)) return null
  try {
    return execFileSync('git', ['-C', workspaceRoot, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      windowsHide: true
    }).trim()
  } catch {
    return null
  }
}

/**
 * Prepare an isolated worktree under the CodeTask data root.
 * Git projects: `git worktree add --detach`.
 * Non-Git: COW base/ + worktree mirrors (see cow.ts).
 */
export function prepareChangeSetWorktree(input: {
  dataDir: string
  changeSetId: string
  workspaceRoot: string
}): { worktreePath: string; baseCommit: string | null; kind: 'git' | 'non_git' } {
  if (isGitWorkspace(input.workspaceRoot)) {
    const worktreePath = changeSetWorktreePath(input.dataDir, input.changeSetId)
    mkdirSync(changeSetRootPath(input.dataDir, input.changeSetId), { recursive: true })
    if (existsSync(worktreePath)) {
      removeChangeSetWorktree(input.dataDir, input.changeSetId, input.workspaceRoot)
    }
    const baseCommit = resolveGitHead(input.workspaceRoot)
    execFileSync(
      'git',
      ['-C', input.workspaceRoot, 'worktree', 'add', '--detach', worktreePath, 'HEAD'],
      { encoding: 'utf8', windowsHide: true }
    )
    return { worktreePath, baseCommit, kind: 'git' }
  }

  const prepared = prepareNonGitCowWorktree(input)
  return {
    worktreePath: prepared.worktreePath,
    baseCommit: prepared.baseFingerprint,
    kind: 'non_git'
  }
}

export function removeChangeSetWorktree(
  dataDir: string,
  changeSetId: string,
  workspaceRoot?: string | null
): void {
  const root = changeSetRootPath(dataDir, changeSetId)
  const worktreePath = changeSetWorktreePath(dataDir, changeSetId)

  if (workspaceRoot && isGitWorkspace(workspaceRoot) && existsSync(worktreePath)) {
    try {
      execFileSync('git', ['-C', workspaceRoot, 'worktree', 'remove', '--force', worktreePath], {
        encoding: 'utf8',
        windowsHide: true
      })
    } catch {
      // fall through to rm
    }
  }

  if (existsSync(root)) {
    rmSync(root, { recursive: true, force: true })
  }
}

/**
 * Re-create a git worktree at current HEAD and try to re-apply the stored patch.
 */
export function rebaseGitWorktree(input: {
  dataDir: string
  changeSetId: string
  workspaceRoot: string
  patchText: string
}): { worktreePath: string; baseCommit: string | null; patchApplied: boolean } {
  removeChangeSetWorktree(input.dataDir, input.changeSetId, input.workspaceRoot)
  const prepared = prepareChangeSetWorktree({
    dataDir: input.dataDir,
    changeSetId: input.changeSetId,
    workspaceRoot: input.workspaceRoot
  })
  if (prepared.kind !== 'git' || !input.patchText.trim()) {
    return {
      worktreePath: prepared.worktreePath,
      baseCommit: prepared.baseCommit,
      patchApplied: false
    }
  }

  try {
    execFileSync('git', ['-C', prepared.worktreePath, 'apply', '--whitespace=nowarn'], {
      encoding: 'utf8',
      windowsHide: true,
      input: input.patchText,
      maxBuffer: 32 * 1024 * 1024
    })
    return {
      worktreePath: prepared.worktreePath,
      baseCommit: prepared.baseCommit,
      patchApplied: true
    }
  } catch {
    return {
      worktreePath: prepared.worktreePath,
      baseCommit: prepared.baseCommit,
      patchApplied: false
    }
  }
}
