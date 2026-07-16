import { eq } from 'drizzle-orm'
import type { TaskProgressSliceDto } from '../legacy-control-plane/types'
import { isTerminalJobStatus } from '../../shared/contracts/retention.ts'
import { getDb } from '../db'
import { threadJobs } from '../db/schema'
import {
  cleanupJobRuntimeTreeIfTerminal,
  estimateJobRuntimeBytes,
  extractRuntimeSummary,
  isTerminalJobStatus as isTerminalRuntimeStatus,
  pruneOrphanRuntimeTrees
} from '../runtime/cleanup'
import { getAppContext } from '../bootstrap'
import { deleteExpiredArtifacts, scheduleJobArtifactExpiry } from './artifacts'
import { deleteJobCounters } from './counters'
import { readRetentionSettings, artifactExpirySec } from './settings'
import { runSqliteMaintenanceIfDue } from './maintenance'
import {
  pruneCompletedTaskRuntimeTrees,
  pruneOrphanAttachments,
  pruneOrphanJobArtifactFiles,
  pruneOrphanMessageArtifactDirs,
  pruneStalePausedRuntimeTrees,
  pruneStaleThreadAttachmentDirs
} from './janitor'
import { pruneEmptyCreateTaskThreads } from '../threads/service'
import {
  deleteExpiredDesignPlanRevisions,
  finalizeDesignPlanRevisions
} from './design-plan-artifacts'

export {
  summarizeEvidence,
  slimEvidenceForState,
  shouldExternalizeSliceVerdict,
  slimSliceVerdict,
  shouldExternalizeEvidence
} from './lifecycle-helpers'
export { storeTaskEvidenceArtifact, storeSliceVerdictArtifact } from './evidence-store'

function nowSec(): number {
  return Math.floor(Date.now() / 1000)
}

export async function onJobStatusTransition(input: {
  jobId: string
  threadId: string
  previousStatus: string
  nextStatus: string
}): Promise<void> {
  if (
    ['pending', 'running'].includes(input.nextStatus) &&
    input.nextStatus !== input.previousStatus
  ) {
    const ctx = getAppContext()
    const rows = await getDb()
      .select({ planRevision: threadJobs.planRevision })
      .from(threadJobs)
      .where(eq(threadJobs.id, input.jobId))
      .limit(1)
    const revision = rows[0]?.planRevision ?? 0
    if (revision > 0) {
      finalizeDesignPlanRevisions(
        getDb(),
        input.jobId,
        revision,
        artifactExpirySec(readRetentionSettings(ctx.settings), 'working')
      )
    }
  }
  if (isTerminalJobStatus(input.nextStatus) && !isTerminalJobStatus(input.previousStatus)) {
    await onJobReachedTerminal(input.jobId, input.threadId, input.nextStatus)
  }
}

export async function onJobReachedTerminal(
  jobId: string,
  threadId: string,
  status: string
): Promise<void> {
  const ctx = getAppContext()
  const db = getDb()
  const settings = readRetentionSettings(ctx.settings)
  const now = nowSec()

  await db
    .update(threadJobs)
    .set({ terminalAt: now, updatedAt: now })
    .where(eq(threadJobs.id, jobId))

  const expiresAt = artifactExpirySec(settings, 'working')
  if (expiresAt != null) {
    await scheduleJobArtifactExpiry(db, jobId, expiresAt)
  }
  const revisionRows = await db
    .select({ planRevision: threadJobs.planRevision })
    .from(threadJobs)
    .where(eq(threadJobs.id, jobId))
    .limit(1)
  const revision = revisionRows[0]?.planRevision ?? 0
  if (revision > 0) finalizeDesignPlanRevisions(db, jobId, revision, expiresAt)

  if (settings.compactCountersOnTerminal) {
    await deleteJobCounters(db, jobId)
    const rows = await db
      .select({ taskMetaJson: threadJobs.taskMetaJson })
      .from(threadJobs)
      .where(eq(threadJobs.id, jobId))
      .limit(1)
    const row = rows[0]
    if (row?.taskMetaJson) {
      try {
        const meta = JSON.parse(row.taskMetaJson) as {
          slices?: TaskProgressSliceDto[]
          milestones?: unknown
          verificationBundleHashes?: Record<string, string>
        }
        await db
          .update(threadJobs)
          .set({
            taskMetaJson: JSON.stringify({
              slices: meta.slices,
              milestones: meta.milestones,
              verificationBundleHashes: meta.verificationBundleHashes
            })
          })
          .where(eq(threadJobs.id, jobId))
      } catch {
        // ignore
      }
    }
  }

  if (settings.runtimeTerminalImmediate && isTerminalRuntimeStatus(status)) {
    try {
      const bytes = await estimateJobRuntimeBytes(ctx.dataDir, threadId, jobId)
      if (bytes > 0) {
        await db.update(threadJobs).set({ runtimeBytes: bytes }).where(eq(threadJobs.id, jobId))
      }
    } catch (error) {
      console.warn('[retention] runtime bytes estimate failed', jobId, error)
    }

    try {
      const summary = await extractRuntimeSummary(ctx.dataDir, threadId, jobId)
      if (summary && (summary.changedFiles.length > 0 || summary.logTail)) {
        const summaryText = [
          summary.changedFiles.length > 0
            ? `Changed files:\n${summary.changedFiles.map((f) => `- ${f}`).join('\n')}`
            : '',
          summary.logTail ? `\nLog tail:\n${summary.logTail}` : ''
        ]
          .filter(Boolean)
          .join('\n')
        if (summaryText) {
          await db.update(threadJobs).set({ summary: summaryText }).where(eq(threadJobs.id, jobId))
        }
      }
    } catch (error) {
      console.warn('[retention] runtime summary extraction failed', jobId, error)
    }

    await cleanupJobRuntimeTreeIfTerminal(ctx.dataDir, threadId, jobId, status).then(
      (result) => {
        if (result === 'deferred_active' || result === 'deferred_slot') {
          // Expected while the executor is still unwinding; finalize retries after release.
          return
        }
      },
      (error) => {
        console.warn('[retention] terminal runtime cleanup failed', jobId, error)
      }
    )
  }
}

export async function runRetentionJanitorPass(): Promise<{
  expiredArtifacts: number
  orphanAttachments: number
  staleRuntimes: number
  completedTaskRuntimes: number
  orphanMessageArtifacts: number
  staleAttachmentDirs: number
  orphanRuntimeTrees: number
  emptyCreateTaskThreads: number
  sqliteMaintenance: { ran: boolean; vacuumedPages: number }
  expiredDesignRevisions: number
  orphanJobArtifactFiles: number
}> {
  const ctx = getAppContext()
  const db = getDb()
  const settings = readRetentionSettings(ctx.settings)
  const [
    artifacts,
    attachments,
    runtimes,
    completedTaskRuntimes,
    messageArtifacts,
    staleAttachmentDirs,
    orphanRuntimeTrees,
    emptyCreateTaskThreads,
    orphanJobArtifactFiles
  ] = await Promise.all([
    deleteExpiredArtifacts(db, ctx.dataDir),
    pruneOrphanAttachments(ctx.dataDir, db),
    pruneStalePausedRuntimeTrees(ctx.dataDir, db, settings.runtimePausedDays),
    pruneCompletedTaskRuntimeTrees(ctx.dataDir, db),
    pruneOrphanMessageArtifactDirs(ctx.dataDir, db),
    pruneStaleThreadAttachmentDirs(ctx.dataDir, db),
    pruneOrphanRuntimeTrees(ctx.dataDir, db),
    pruneEmptyCreateTaskThreads(),
    pruneOrphanJobArtifactFiles(ctx.dataDir, db)
  ])

  const expiredDesignRevisions = deleteExpiredDesignPlanRevisions(db)

  const sqliteMaintenance = runSqliteMaintenanceIfDue({
    db,
    store: ctx.settings,
    settings
  })

  return {
    expiredArtifacts: artifacts.deleted,
    orphanAttachments: attachments.removed,
    staleRuntimes: runtimes.removed,
    completedTaskRuntimes: completedTaskRuntimes.removed,
    orphanMessageArtifacts: messageArtifacts.removed,
    staleAttachmentDirs: staleAttachmentDirs.removed,
    orphanRuntimeTrees: orphanRuntimeTrees.removedPaths.length,
    emptyCreateTaskThreads: emptyCreateTaskThreads.removed,
    sqliteMaintenance: {
      ran: sqliteMaintenance.ran,
      vacuumedPages: sqliteMaintenance.vacuumedPages
    },
    expiredDesignRevisions: expiredDesignRevisions.deleted,
    orphanJobArtifactFiles: orphanJobArtifactFiles.removed
  }
}

let janitorTimer: NodeJS.Timeout | null = null

export function startRetentionJanitor(): void {
  if (janitorTimer) return
  const settings = readRetentionSettings(getAppContext().settings)
  const intervalMs = Math.max(1, settings.pruneIntervalHours) * 3_600_000

  void runRetentionJanitorPass().catch((error) => {
    console.warn('[retention] initial janitor pass failed', error)
  })

  janitorTimer = setInterval(() => {
    void runRetentionJanitorPass().catch((error) => {
      console.warn('[retention] janitor pass failed', error)
    })
  }, intervalMs)
  janitorTimer.unref?.()
}

export function stopRetentionJanitor(): void {
  if (janitorTimer) {
    clearInterval(janitorTimer)
    janitorTimer = null
  }
}
