import { existsSync } from 'fs'
import { rm } from 'fs/promises'
import { join } from 'path'

/**
 * Legacy CodeTask per-turn trees under data/runtimes.
 * No longer created — helpers only wipe leftovers safely.
 */
function legacyRuntimesRoot(dataDir: string): string {
  return join(dataDir, 'runtimes')
}

function legacyThreadRuntimeDir(dataDir: string, threadId: string): string {
  return join(legacyRuntimesRoot(dataDir), threadId)
}

function legacyJobRuntimeDir(dataDir: string, threadId: string, jobId: string): string {
  return join(legacyThreadRuntimeDir(dataDir, threadId), 'jobs', jobId)
}

/** @deprecated Path helpers retained for tests that assert legacy wipe targets. */
export function threadRuntimeDir(dataDir: string, threadId: string): string {
  return legacyThreadRuntimeDir(dataDir, threadId)
}

/** @deprecated */
export function jobRuntimeDir(dataDir: string, threadId: string, jobId: string): string {
  return legacyJobRuntimeDir(dataDir, threadId, jobId)
}

export async function removeDirectoryIfExists(path: string): Promise<boolean> {
  if (!existsSync(path)) return false
  await rm(path, { recursive: true, force: true })
  return true
}

/**
 * Wipe the entire legacy data/runtimes tree. SDK/ACP no longer store anything there.
 */
export async function wipeLegacyRuntimesRoot(dataDir: string): Promise<{ removed: number }> {
  const root = legacyRuntimesRoot(dataDir)
  if (!existsSync(root)) return { removed: 0 }
  await rm(root, { recursive: true, force: true })
  return { removed: 1 }
}

export type CleanupJobRuntimeResult =
  | 'deleted'
  | 'absent'
  | 'deferred_active'
  | 'deferred_slot'

/**
 * Delete a legacy Job runtime tree when present.
 * Returns deferred_* when the execution loop or workload slot is still held.
 */
export async function cleanupJobRuntimeTree(
  dataDir: string,
  threadId: string,
  jobId: string,
  options: { deletionDrained?: boolean } = {}
): Promise<CleanupJobRuntimeResult> {
  if (options.deletionDrained) {
    const removed = await removeDirectoryIfExists(legacyJobRuntimeDir(dataDir, threadId, jobId))
    return removed ? 'deleted' : 'absent'
  }
  try {
    const { getAppContext } = await import('../bootstrap')
    const ctx = getAppContext()
    if (ctx.executionRuntime.isLoopActive(jobId)) {
      return 'deferred_active'
    }
    const { listActiveWorkloadSlots } = await import('../legacy-control-plane/workload-slot-store')
    if ((await listActiveWorkloadSlots()).some((slot) => slot.ownerId === jobId)) {
      return 'deferred_slot'
    }
  } catch {
    // Standalone retention tests may not have a bootstrapped application context.
  }
  const removed = await removeDirectoryIfExists(legacyJobRuntimeDir(dataDir, threadId, jobId))
  return removed ? 'deleted' : 'absent'
}

export function isDeferredCleanupResult(
  result: CleanupJobRuntimeResult | 'skipped_non_terminal'
): result is 'deferred_active' | 'deferred_slot' {
  return result === 'deferred_active' || result === 'deferred_slot'
}

function legacyJobTaskRuntimeDir(
  dataDir: string,
  threadId: string,
  jobId: string,
  taskId: string
): string {
  return join(legacyJobRuntimeDir(dataDir, threadId, jobId), 'tasks', taskId)
}

export async function cleanupJobTaskRuntimeTree(
  dataDir: string,
  threadId: string,
  jobId: string,
  taskId: string
): Promise<boolean> {
  return removeDirectoryIfExists(legacyJobTaskRuntimeDir(dataDir, threadId, jobId, taskId))
}

export async function cleanupThreadRuntimeTree(
  dataDir: string,
  threadId: string,
  options: { deletionDrained?: boolean } = {}
): Promise<void> {
  try {
    if (options.deletionDrained) {
      await removeDirectoryIfExists(legacyThreadRuntimeDir(dataDir, threadId))
      return
    }
    const { getAppContext } = await import('../bootstrap')
    if (getAppContext().runtimeRegistry.isThreadInflight(threadId)) {
      throw new Error(`Refusing to delete active thread runtime: ${threadId}`)
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Refusing to delete')) throw error
  }
  await removeDirectoryIfExists(legacyThreadRuntimeDir(dataDir, threadId))
}

const TERMINAL_JOB_STATUSES = new Set(['completed', 'failed', 'cancelled'])

export function isTerminalJobStatus(status: string): boolean {
  return TERMINAL_JOB_STATUSES.has(status)
}

export async function cleanupJobRuntimeTreeIfTerminal(
  dataDir: string,
  threadId: string,
  jobId: string,
  status: string
): Promise<CleanupJobRuntimeResult | 'skipped_non_terminal'> {
  if (!isTerminalJobStatus(status)) return 'skipped_non_terminal'
  return cleanupJobRuntimeTree(dataDir, threadId, jobId)
}

/** Wipe leftover data/runtimes (no longer created by the product). */
export async function pruneOrphanRuntimeTrees(
  dataDir: string
): Promise<{ removedPaths: string[] }> {
  const result = await wipeLegacyRuntimesRoot(dataDir)
  if (result.removed === 0) return { removedPaths: [] }
  return { removedPaths: [legacyRuntimesRoot(dataDir)] }
}
