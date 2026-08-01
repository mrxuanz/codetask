import { cpSync, existsSync, mkdirSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'

/**
 * Copy a fixture workspace into an isolated run directory.
 * Returns the destination path.
 */
export function copyFixtureWorkspace(options: {
  repoRoot: string
  fixtureWorkspaceName: string
  destinationRoot: string
}): string {
  const source = join(
    options.repoRoot,
    'tests/business-e2e/fixtures/workspaces',
    options.fixtureWorkspaceName
  )
  if (!existsSync(source)) {
    throw new Error(`fixture_workspace_missing:${source}`)
  }
  mkdirSync(options.destinationRoot, { recursive: true })
  cpSync(source, options.destinationRoot, { recursive: true })
  return options.destinationRoot
}

export function assertWorkspaceCopied(destinationRoot: string, expectedFiles: string[]): void {
  for (const relative of expectedFiles) {
    const full = join(destinationRoot, relative)
    if (!existsSync(full)) {
      throw new Error(`workspace_copy_missing_file:${relative}`)
    }
  }
}

/**
 * Keep provider-side git discovery inside the case workspace. Business E2E runs live below the
 * product repository, so without a nested repository `git status` exposes source fixtures and
 * oracle expectations from the parent checkout to the model under test.
 */
export function initializeWorkspaceGitBoundary(destinationRoot: string): void {
  const workspaceRoot = realpathSync(resolve(destinationRoot))
  const runGit = (args: string[], label: string): string => {
    const result = spawnSync('git', args, {
      cwd: workspaceRoot,
      encoding: 'utf8',
      windowsHide: true
    })
    if (result.error || result.status !== 0) {
      throw new Error(
        `workspace_git_${label}_failed:${result.error?.message ?? result.stderr.trim()}`
      )
    }
    return result.stdout.trim()
  }

  runGit(['-c', 'init.defaultBranch=main', 'init', '--quiet'], 'init')
  runGit(['add', '--all'], 'add')
  runGit(
    [
      '-c',
      'user.name=Business E2E',
      '-c',
      'user.email=business-e2e@localhost',
      'commit',
      '--quiet',
      '--allow-empty',
      '-m',
      'Business E2E fixture baseline'
    ],
    'commit'
  )

  const topLevel = realpathSync(resolve(runGit(['rev-parse', '--show-toplevel'], 'verify')))
  if (topLevel !== workspaceRoot) {
    throw new Error(`workspace_git_boundary_mismatch:${topLevel}:${workspaceRoot}`)
  }
}

export function listTopLevelEntries(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter((name) => {
    try {
      return statSync(join(dir, name)).isFile() || statSync(join(dir, name)).isDirectory()
    } catch {
      return false
    }
  })
}
