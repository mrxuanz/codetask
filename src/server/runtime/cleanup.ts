import { existsSync } from 'fs'
import { readdir, rm } from 'fs/promises'
import { join } from 'path'
import type { getDb } from '../db'
import { threadJobs, threads } from '../db/schema'

type AppDatabase = ReturnType<typeof getDb>

export function threadRuntimeDir(dataDir: string, threadId: string): string {
  return join(dataDir, 'runtimes', threadId)
}

export function jobRuntimeDir(dataDir: string, threadId: string, jobId: string): string {
  return join(dataDir, 'runtimes', threadId, 'jobs', jobId)
}

export async function removeDirectoryIfExists(path: string): Promise<boolean> {
  if (!existsSync(path)) return false
  await rm(path, { recursive: true, force: true })
  return true
}

export async function cleanupJobRuntimeTree(
  dataDir: string,
  threadId: string,
  jobId: string
): Promise<void> {
  await removeDirectoryIfExists(jobRuntimeDir(dataDir, threadId, jobId))
}

export async function cleanupThreadRuntimeTree(dataDir: string, threadId: string): Promise<void> {
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
): Promise<void> {
  if (!isTerminalJobStatus(status)) return
  await cleanupJobRuntimeTree(dataDir, threadId, jobId)
}

export async function pruneOrphanRuntimeTrees(
  dataDir: string,
  db: AppDatabase
): Promise<{ removedPaths: string[] }> {
  const runtimesRoot = join(dataDir, 'runtimes')
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
