import { desc, eq } from 'drizzle-orm'
import { isTerminalJobStatus } from '../../shared/contracts/retention.ts'
import { getDb } from '../db'
import { designPlanRevisions } from '../db/schema'
import {
  cleanupJobRuntimeTreeIfTerminal,
  isTerminalJobStatus as isTerminalRuntimeStatus
} from '../runtime/cleanup'
import { getAppContext } from '../bootstrap'
import { deleteExpiredArtifacts, scheduleJobArtifactExpiry } from './artifacts'
import { deleteJobCounters } from './counters'
import { readRetentionSettings, artifactExpirySec } from './settings'
import { runSqliteMaintenanceIfDue } from './maintenance'
import {
  pruneOrphanAttachments,
  pruneOrphanJobArtifactFiles,
  pruneOrphanMessageArtifactDirs,
  pruneStaleThreadAttachmentDirs,
  wipeLegacyProductRuntimes
} from './janitor'
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

function sqliteClient(): import('better-sqlite3').Database | null {
  const db = getDb()
  return (db as { $client?: import('better-sqlite3').Database }).$client ?? null
}

/** Current plan revision for a job id (host design_plan_revisions; Execution tree is separate). */
function readCurrentPlanRevision(jobId: string): number {
  const row = getDb()
    .select({ planRevision: designPlanRevisions.planRevision })
    .from(designPlanRevisions)
    .where(eq(designPlanRevisions.jobId, jobId))
    .orderBy(desc(designPlanRevisions.planRevision))
    .limit(1)
    .all()[0]
  return row?.planRevision ?? 0
}

function markExecutionJobTerminal(jobId: string, terminalAt: number): void {
  const client = sqliteClient()
  if (!client) return
  try {
    client
      .prepare(`UPDATE jobs SET terminal_at = ?, updated_at = ? WHERE id = ?`)
      .run(terminalAt * 1000, terminalAt * 1000, jobId)
  } catch {
    // jobs table may be absent on partial fixtures
  }
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
    const revision = readCurrentPlanRevision(input.jobId)
    if (revision > 0) {
      finalizeDesignPlanRevisions(
        getDb(),
        input.jobId,
        revision,
        artifactExpirySec(readRetentionSettings(ctx.config), 'working')
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
  const settings = readRetentionSettings(ctx.config)
  const now = nowSec()

  markExecutionJobTerminal(jobId, now)

  const expiresAt = artifactExpirySec(settings, 'working')
  if (expiresAt != null) {
    await scheduleJobArtifactExpiry(db, jobId, expiresAt)
  }
  const revision = readCurrentPlanRevision(jobId)
  if (revision > 0) finalizeDesignPlanRevisions(db, jobId, revision, expiresAt)

  if (settings.compactCountersOnTerminal) {
    await deleteJobCounters(db, jobId)
  }

  if (settings.runtimeTerminalImmediate && isTerminalRuntimeStatus(status)) {
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
  legacyRuntimesRemoved: number
  orphanMessageArtifacts: number
  staleAttachmentDirs: number
  sqliteMaintenance: { ran: boolean; vacuumedPages: number }
  expiredDesignRevisions: number
  orphanJobArtifactFiles: number
  expiredRealtimeEvents: number
}> {
  const ctx = getAppContext()
  const db = getDb()
  const settings = readRetentionSettings(ctx.config)
  const [
    artifacts,
    attachments,
    legacyRuntimes,
    messageArtifacts,
    staleAttachmentDirs,
    orphanJobArtifactFiles
  ] = await Promise.all([
    deleteExpiredArtifacts(db, ctx.dataDir),
    pruneOrphanAttachments(ctx.dataDir, db),
    wipeLegacyProductRuntimes(ctx.dataDir),
    pruneOrphanMessageArtifactDirs(ctx.dataDir, db),
    pruneStaleThreadAttachmentDirs(ctx.dataDir, db),
    pruneOrphanJobArtifactFiles(ctx.dataDir, db)
  ])

  const expiredDesignRevisions = deleteExpiredDesignPlanRevisions(db)
  const expiredRealtimeEvents = ctx.realtime.janitorOnce()

  const sqliteMaintenance = runSqliteMaintenanceIfDue({
    db,
    store: ctx.settings,
    settings
  })

  return {
    expiredArtifacts: artifacts.deleted,
    orphanAttachments: attachments.removed,
    legacyRuntimesRemoved: legacyRuntimes.removed,
    orphanMessageArtifacts: messageArtifacts.removed,
    staleAttachmentDirs: staleAttachmentDirs.removed,
    sqliteMaintenance: {
      ran: sqliteMaintenance.ran,
      vacuumedPages: sqliteMaintenance.vacuumedPages
    },
    expiredDesignRevisions: expiredDesignRevisions.deleted,
    orphanJobArtifactFiles: orphanJobArtifactFiles.removed,
    expiredRealtimeEvents
  }
}

let janitorTimer: NodeJS.Timeout | null = null

export function startRetentionJanitor(): void {
  if (janitorTimer) return
  const settings = readRetentionSettings(getAppContext().config)
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
