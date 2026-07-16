import { existsSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { inArray } from 'drizzle-orm'
import { dataPaths } from '../data-paths'
import { getDb } from '../db'
import { changeSets } from '../db/schema'
import { changeSetRootPath } from './paths'
import { removeChangeSetWorktree } from './worktree'

const TERMINAL_STATUSES = ['applied', 'cancelled', 'failed'] as const

/**
 * Remove on-disk Change Set trees for terminal rows that no longer need a worktree.
 * Safe to call from retention / startup janitor.
 */
export async function pruneTerminalChangeSetTrees(dataDir: string): Promise<{ removed: number }> {
  const db = getDb()
  const rows = await db
    .select({
      id: changeSets.id,
      status: changeSets.status,
      worktreePath: changeSets.worktreePath
    })
    .from(changeSets)
    .where(inArray(changeSets.status, [...TERMINAL_STATUSES]))

  let removed = 0
  for (const row of rows) {
    const root = changeSetRootPath(dataDir, row.id)
    if (!existsSync(root)) continue
    removeChangeSetWorktree(dataDir, row.id, null)
    removed += 1
  }

  // Also drop orphan directories under runtimes/changes with no DB row.
  const changesRoot = join(dataPaths(dataDir).runtimes, 'changes')
  if (existsSync(changesRoot)) {
    const known = new Set(rows.map((row) => row.id))
    // Include non-terminal ids so we don't delete live worktrees.
    const live = await db.select({ id: changeSets.id }).from(changeSets)
    for (const row of live) known.add(row.id)

    for (const name of readdirSync(changesRoot)) {
      if (known.has(name)) continue
      const orphan = join(changesRoot, name)
      try {
        rmSync(orphan, { recursive: true, force: true })
        removed += 1
      } catch {
        // best-effort
      }
    }
  }

  return { removed }
}
