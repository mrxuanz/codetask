import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

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
