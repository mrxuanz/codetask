import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import {
  validateJobInvariant,
  type InvariantViolation,
  type ActiveRunSummary
} from '../../../domain/jobs/job-invariants'
import type {
  JobState,
  ControlIntent,
  ResumeTarget
} from '../../../../shared/contracts/control-plane/primitives'
import { controlJobs, controlJobRuns } from './schema'

type SweepSchema = {
  controlJobs: typeof controlJobs
  controlJobRuns: typeof controlJobRuns
}

export type QuarantinedJob = {
  readonly jobId: string
  readonly violations: readonly InvariantViolation[]
}

type JobRow = {
  readonly id: string
  readonly threadId: string
  readonly projectId: string
  readonly state: string
  readonly stateRevision: number
  readonly controlIntent: string
  readonly resumeTarget: string | null
  readonly currentPlanRevision: number | null
  readonly executionGeneration: number
  readonly activeRunId: string | null
  readonly lastFailureId: string | null
}

type RunRow = {
  readonly id: string
  readonly state: string
  readonly fenceToken: string
  readonly executionGeneration: number
  readonly currentRuntimeInstanceId: string | null
  readonly pendingAttemptId: string | null
  readonly lifecycleOperationId: string | null
}

function parseJobRow(input: unknown): JobRow {
  if (typeof input !== 'object' || input === null) {
    throw new Error('invalid job row')
  }
  const r = input as Record<string, unknown>
  if (
    typeof r.id !== 'string' ||
    typeof r.threadId !== 'string' ||
    typeof r.projectId !== 'string' ||
    typeof r.state !== 'string' ||
    typeof r.stateRevision !== 'number' ||
    typeof r.controlIntent !== 'string' ||
    typeof r.executionGeneration !== 'number'
  ) {
    throw new Error('invalid job row shape')
  }
  return {
    id: r.id,
    threadId: r.threadId,
    projectId: r.projectId,
    state: r.state,
    stateRevision: r.stateRevision,
    controlIntent: r.controlIntent,
    resumeTarget: (r.resumeTarget === null || typeof r.resumeTarget === 'string') ? r.resumeTarget : null,
    currentPlanRevision: (r.currentPlanRevision === null || typeof r.currentPlanRevision === 'number') ? r.currentPlanRevision : null,
    executionGeneration: r.executionGeneration,
    activeRunId: (r.activeRunId === null || typeof r.activeRunId === 'string') ? r.activeRunId : null,
    lastFailureId: (r.lastFailureId === null || typeof r.lastFailureId === 'string') ? r.lastFailureId : null
  }
}

function parseRunRow(input: unknown): RunRow | null {
  if (input === null || input === undefined) return null
  if (typeof input !== 'object') return null
  const r = input as Record<string, unknown>
  if (
    typeof r.id !== 'string' ||
    typeof r.state !== 'string' ||
    typeof r.fenceToken !== 'string' ||
    typeof r.executionGeneration !== 'number'
  ) {
    return null
  }
  return {
    id: r.id,
    state: r.state,
    fenceToken: r.fenceToken,
    executionGeneration: r.executionGeneration,
    currentRuntimeInstanceId: (r.currentRuntimeInstanceId === null || typeof r.currentRuntimeInstanceId === 'string') ? r.currentRuntimeInstanceId : null,
    pendingAttemptId: (r.pendingAttemptId === null || typeof r.pendingAttemptId === 'string') ? r.pendingAttemptId : null,
    lifecycleOperationId: (r.lifecycleOperationId === null || typeof r.lifecycleOperationId === 'string') ? r.lifecycleOperationId : null
  }
}

function toJobAggregate(row: JobRow): {
  readonly id: string
  readonly state: JobState
  readonly controlIntent: ControlIntent
  readonly resumeTarget: ResumeTarget | null
  readonly executionGeneration: number
  readonly activeRunId: string | null
} {
  return {
    id: row.id,
    state: row.state as JobState,
    controlIntent: row.controlIntent as ControlIntent,
    resumeTarget: row.resumeTarget as ResumeTarget | null,
    executionGeneration: row.executionGeneration,
    activeRunId: row.activeRunId
  }
}

export function createInvariantSweep(
  db: BetterSQLite3Database<SweepSchema>
): { sweep(): readonly QuarantinedJob[] } {
  return {
    sweep(): readonly QuarantinedJob[] {
      const jobRows = db
        .select({
          id: controlJobs.id,
          threadId: controlJobs.threadId,
          projectId: controlJobs.projectId,
          state: controlJobs.state,
          stateRevision: controlJobs.stateRevision,
          controlIntent: controlJobs.controlIntent,
          resumeTarget: controlJobs.resumeTarget,
          currentPlanRevision: controlJobs.currentPlanRevision,
          executionGeneration: controlJobs.executionGeneration,
          activeRunId: controlJobs.activeRunId,
          lastFailureId: controlJobs.lastFailureId
        })
        .from(controlJobs)
        .all()

      const quarantined: QuarantinedJob[] = []

      for (const rawRow of jobRows) {
        const row = parseJobRow(rawRow as unknown)
        const job = toJobAggregate(row)

        let activeRun: ActiveRunSummary | null = null
        if (job.activeRunId !== null) {
          const runRows = db
            .select({
              id: controlJobRuns.id,
              state: controlJobRuns.state,
              fenceToken: controlJobRuns.fenceToken,
              executionGeneration: controlJobRuns.executionGeneration,
              currentRuntimeInstanceId: controlJobRuns.currentRuntimeInstanceId,
              pendingAttemptId: controlJobRuns.pendingAttemptId,
              lifecycleOperationId: controlJobRuns.lifecycleOperationId
            })
            .from(controlJobRuns)
            .where(eq(controlJobRuns.id, job.activeRunId))
            .limit(1)
            .all()

          activeRun = parseRunRow(runRows[0] as unknown) as ActiveRunSummary | null
        }

        const violations = validateJobInvariant(
          job as Parameters<typeof validateJobInvariant>[0],
          activeRun
        )
        if (violations.length > 0) {
          quarantined.push({ jobId: job.id, violations })
        }
      }

      return quarantined
    }
  }
}
