import { join } from 'node:path'
import { dataPaths } from '../data-paths'

export function changeSetRootPath(dataDir: string, changeSetId: string): string {
  return join(dataPaths(dataDir).runtimes, 'changes', changeSetId)
}

export function changeSetWorktreePath(dataDir: string, changeSetId: string): string {
  return join(changeSetRootPath(dataDir, changeSetId), 'worktree')
}

export function changeSetRuntimePath(dataDir: string, changeSetId: string, provider: string): string {
  return join(changeSetRootPath(dataDir, changeSetId), provider)
}
