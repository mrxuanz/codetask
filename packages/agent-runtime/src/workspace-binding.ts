import { createHash } from 'node:crypto'
import { realpathSync, statSync } from 'node:fs'
import { isAbsolute, normalize } from 'node:path'
import { createTurnError } from '@codetask/contracts/turn-errors'

const WORKSPACE_AUTHORITY_TAG = '[CODETASK_WORKSPACE_AUTHORITY]'

export interface WorkspaceBinding {
  readonly workspaceRoot: string
  readonly fingerprint: string
}

function canonicalDirectory(input: string, label: 'workspaceRoot'): string {
  const trimmed = input.trim()
  if (!trimmed || !isAbsolute(trimmed)) {
    throw createTurnError('workspace.path_invalid', {
      detail: `${label} must be a non-empty absolute path: ${input}`
    })
  }

  try {
    const canonical = realpathSync.native(normalize(trimmed))
    if (!statSync(canonical).isDirectory()) {
      throw new Error('path is not a directory')
    }
    return canonical
  } catch (error) {
    throw createTurnError('workspace.path_invalid', {
      detail: `${label} cannot be canonicalized as an existing directory: ${trimmed} (${
        error instanceof Error ? error.message : String(error)
      })`
    })
  }
}

function pathComparisonKey(path: string): string {
  return process.platform === 'win32' ? path.toLowerCase() : path
}

export function workspacePathsEqual(left: string, right: string): boolean {
  try {
    return (
      pathComparisonKey(canonicalDirectory(left, 'workspaceRoot')) ===
      pathComparisonKey(canonicalDirectory(right, 'workspaceRoot'))
    )
  } catch {
    return false
  }
}

export function assertProviderWorkspace(
  provider: string,
  expectedWorkspaceRoot: string,
  reportedWorkspaceRoot: string
): void {
  if (workspacePathsEqual(expectedWorkspaceRoot, reportedWorkspaceRoot)) return
  throw createTurnError('provider.workspace_mismatch', {
    params: { provider },
    detail: `Expected ${expectedWorkspaceRoot}; provider reported ${reportedWorkspaceRoot}`
  })
}

export function resolveWorkspaceBinding(input: { workspaceRoot: string }): WorkspaceBinding {
  const workspaceRoot = canonicalDirectory(input.workspaceRoot, 'workspaceRoot')
  const fingerprint = createHash('sha256').update(pathComparisonKey(workspaceRoot)).digest('hex')

  return { workspaceRoot, fingerprint }
}

export function appendWorkspaceAuthorityPrompt(
  systemPrompt: string | undefined,
  workspaceRoot: string
): string {
  const existing = systemPrompt?.trim()
  if (existing?.includes(WORKSPACE_AUTHORITY_TAG)) return existing

  const authority = `${WORKSPACE_AUTHORITY_TAG}
The authoritative project workspace root for this turn is:
${workspaceRoot}

Resolve every relative file path and every reference to "the project", "project root", "workspace", or "workspace root" against that exact directory. A repository root, process working directory, provider data directory, or another root mentioned by provider context is informational only and must never replace it. Do not create, modify, move, or delete files outside this directory.`

  return existing ? `${existing}\n\n${authority}` : authority
}
