import { existsSync } from 'fs'
import { readdir, readFile, rm, stat } from 'fs/promises'
import { isAbsolute, join, relative, sep } from 'path'
import type { getDb } from '../db'
import { threadJobs, threads } from '../db/schema'
import {
  dataPaths,
  jobRuntimeDirPath,
  jobTaskRuntimeDirPath,
  threadRuntimeDirPath
} from '../data-paths'

type AppDatabase = ReturnType<typeof getDb>

export function threadRuntimeDir(dataDir: string, threadId: string): string {
  return threadRuntimeDirPath(dataDir, threadId)
}

export function jobRuntimeDir(dataDir: string, threadId: string, jobId: string): string {
  return jobRuntimeDirPath(dataDir, threadId, jobId)
}

export function jobTaskRuntimeDir(
  dataDir: string,
  threadId: string,
  jobId: string,
  taskId: string
): string {
  return jobTaskRuntimeDirPath(dataDir, threadId, jobId, taskId)
}

async function estimateDirectoryBytes(dir: string): Promise<number> {
  if (!existsSync(dir)) return 0
  let total = 0
  try {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        total += await estimateDirectoryBytes(full)
      } else if (entry.isFile()) {
        try {
          total += (await stat(full)).size
        } catch {
          // skip files that disappear during measurement
        }
      }
    }
  } catch {
    // skip inaccessible directories
  }
  return total
}

export async function estimateJobRuntimeBytes(
  dataDir: string,
  threadId: string,
  jobId: string
): Promise<number> {
  return estimateDirectoryBytes(jobRuntimeDir(dataDir, threadId, jobId))
}

export async function removeDirectoryIfExists(path: string): Promise<boolean> {
  if (!existsSync(path)) return false
  await rm(path, { recursive: true, force: true })
  return true
}

export type CleanupJobRuntimeResult =
  | 'deleted'
  | 'absent'
  | 'deferred_active'
  | 'deferred_slot'

/**
 * Delete the Job runtime tree when safe.
 * Returns deferred_* when the execution loop or workload slot is still held so callers can
 * retry after unwind (status often flips to terminal before finally/release).
 */
export async function cleanupJobRuntimeTree(
  dataDir: string,
  threadId: string,
  jobId: string,
  options: { deletionDrained?: boolean } = {}
): Promise<CleanupJobRuntimeResult> {
  if (options.deletionDrained) {
    const removed = await removeDirectoryIfExists(jobRuntimeDir(dataDir, threadId, jobId))
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
  const removed = await removeDirectoryIfExists(jobRuntimeDir(dataDir, threadId, jobId))
  return removed ? 'deleted' : 'absent'
}

export function isDeferredCleanupResult(
  result: CleanupJobRuntimeResult | 'skipped_non_terminal'
): result is 'deferred_active' | 'deferred_slot' {
  return result === 'deferred_active' || result === 'deferred_slot'
}

/**
 * Completed task checkpoints and evidence are durable in SQLite/blob artifacts. Their Provider
 * runtime is disposable even while later tasks in the same Job are still running.
 */
export async function cleanupJobTaskRuntimeTree(
  dataDir: string,
  threadId: string,
  jobId: string,
  taskId: string
): Promise<boolean> {
  const tasksRoot = join(jobRuntimeDir(dataDir, threadId, jobId), 'tasks')
  const taskRuntime = jobTaskRuntimeDir(dataDir, threadId, jobId, taskId)
  const relativeTaskPath = relative(tasksRoot, taskRuntime)
  if (
    !relativeTaskPath ||
    relativeTaskPath === '..' ||
    relativeTaskPath.startsWith(`..${sep}`) ||
    isAbsolute(relativeTaskPath)
  ) {
    console.warn('[retention] refused task runtime path outside task root', jobId, taskId)
    return false
  }
  return removeDirectoryIfExists(taskRuntime)
}

export async function cleanupThreadRuntimeTree(
  dataDir: string,
  threadId: string,
  options: { deletionDrained?: boolean } = {}
): Promise<void> {
  try {
    if (options.deletionDrained) {
      await removeDirectoryIfExists(threadRuntimeDir(dataDir, threadId))
      return
    }
    const { getAppContext } = await import('../bootstrap')
    if (getAppContext().runtimeRegistry.isThreadInflight(threadId)) {
      throw new Error(`Refusing to delete active thread runtime: ${threadId}`)
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Refusing to delete')) throw error
  }
  await removeDirectoryIfExists(threadRuntimeDir(dataDir, threadId))
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

export async function pruneOrphanRuntimeTrees(
  dataDir: string,
  db: AppDatabase
): Promise<{ removedPaths: string[] }> {
  const runtimesRoot = dataPaths(dataDir).runtimes
  if (!existsSync(runtimesRoot)) return { removedPaths: [] }

  const [threadRows, jobRows] = await Promise.all([
    db.select({ id: threads.id }).from(threads),
    db.select({ id: threadJobs.id, threadId: threadJobs.threadId }).from(threadJobs)
  ])

  const validThreadIds = new Set(threadRows.map((row) => row.id))
  const validJobDirs = new Set(jobRows.map((row) => `${row.threadId}/${row.id}`))
  const removedPaths: string[] = []

  for (const threadEntry of await readdir(runtimesRoot, { withFileTypes: true })) {
    if (!threadEntry.isDirectory()) continue
    const threadId = threadEntry.name
    const threadPath = join(runtimesRoot, threadId)

    if (!validThreadIds.has(threadId)) {
      await rm(threadPath, { recursive: true, force: true })
      removedPaths.push(threadPath)
      continue
    }

    const jobsPath = join(threadPath, 'jobs')
    if (!existsSync(jobsPath)) continue

    for (const jobEntry of await readdir(jobsPath, { withFileTypes: true })) {
      if (!jobEntry.isDirectory()) continue
      const key = `${threadId}/${jobEntry.name}`
      if (validJobDirs.has(key)) continue
      const jobPath = join(jobsPath, jobEntry.name)
      await rm(jobPath, { recursive: true, force: true })
      removedPaths.push(jobPath)
    }
  }

  return { removedPaths }
}

export interface RuntimeSummary {
  changedFiles: string[]
  logTail: string | null
}

export async function extractRuntimeSummary(
  dataDir: string,
  threadId: string,
  jobId: string
): Promise<RuntimeSummary | null> {
  const dir = jobRuntimeDir(dataDir, threadId, jobId)
  if (!existsSync(dir)) return null

  const changedFiles: string[] = []
  let logTail: string | null = null

  try {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== '.git') {
        try {
          const subEntries = await readdir(join(dir, entry.name), { withFileTypes: true })
          for (const sub of subEntries) {
            if (sub.isFile()) {
              changedFiles.push(`${entry.name}/${sub.name}`)
            }
          }
        } catch {
          // skip
        }
      }
    }

    const logPaths = [join(dir, 'stderr.log'), join(dir, 'stdout.log'), join(dir, 'agent.log')]
    for (const logPath of logPaths) {
      if (existsSync(logPath)) {
        try {
          const content = await readFile(logPath, 'utf8')
          const lines = content.split('\n')
          logTail = lines.slice(-50).join('\n')
          break
        } catch {
          // skip
        }
      }
    }
  } catch {
    // skip
  }

  if (changedFiles.length === 0 && !logTail) return null
  return { changedFiles, logTail }
}
