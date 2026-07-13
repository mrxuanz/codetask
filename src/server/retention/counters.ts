import { eq } from 'drizzle-orm'
import type { TaskProgressDto } from '../legacy-control-plane/types'
import type { getDb } from '../db'
import { jobCounters } from '../db/schema'

type AppDatabase = ReturnType<typeof getDb>

function nowSec(): number {
  return Math.floor(Date.now() / 1000)
}

function counterEntries(progress: TaskProgressDto): Array<{ key: string; value: number }> {
  const entries: Array<{ key: string; value: number }> = []
  for (const [key, value] of Object.entries(progress.repairGenerations ?? {})) {
    if (typeof value === 'number') entries.push({ key, value })
  }
  for (const [key, value] of Object.entries(progress.verificationAttempts ?? {})) {
    if (typeof value === 'number') entries.push({ key: `verify-attempt:${key}`, value })
  }
  return entries
}

export function syncJobCountersFromProgressInTx(
  db: AppDatabase,
  jobId: string,
  progress: TaskProgressDto
): void {
  db.delete(jobCounters).where(eq(jobCounters.jobId, jobId)).run()
  const now = nowSec()
  for (const entry of counterEntries(progress)) {
    db.insert(jobCounters)
      .values({
        jobId,
        counterKey: entry.key,
        value: entry.value,
        updatedAt: now
      })
      .run()
  }
}

export async function syncJobCountersFromProgress(
  db: AppDatabase,
  jobId: string,
  progress: TaskProgressDto
): Promise<void> {
  syncJobCountersFromProgressInTx(db, jobId, progress)
}

export async function loadJobCountersIntoProgress(
  db: AppDatabase,
  jobId: string,
  progress: TaskProgressDto
): Promise<TaskProgressDto> {
  const rows = await db.select().from(jobCounters).where(eq(jobCounters.jobId, jobId))
  if (rows.length === 0) return progress

  const repairGenerations: Record<string, number> = { ...(progress.repairGenerations ?? {}) }
  const verificationAttempts: Record<string, number> = { ...(progress.verificationAttempts ?? {}) }

  for (const row of rows) {
    if (row.counterKey.startsWith('verify-attempt:')) {
      verificationAttempts[row.counterKey.slice('verify-attempt:'.length)] = row.value
    } else {
      repairGenerations[row.counterKey] = row.value
    }
  }

  return {
    ...progress,
    repairGenerations,
    verificationAttempts
  }
}

export async function deleteJobCounters(db: AppDatabase, jobId: string): Promise<void> {
  await db.delete(jobCounters).where(eq(jobCounters.jobId, jobId))
}
