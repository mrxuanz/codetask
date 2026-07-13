import { randomUUID } from 'crypto'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import type Database from 'better-sqlite3'
import type { JobCommandService } from '@shared/contracts/control-plane'
import type { AppDatabase } from '../db'
import { controlPlaneSchema } from '../infra/sqlite/control-plane/schema'
import {
  SqliteJobRepository,
  type ControlPlaneDatabase
} from '../infra/sqlite/control-plane/job-repository'
import { SqliteTaskRepository } from '../infra/sqlite/control-plane/task-repository'
import { EvidenceRepository } from '../infra/sqlite/control-plane/evidence-repository'
import {
  parseJobState,
  parseControlIntent,
  parseResumeTarget
} from '../infra/sqlite/control-plane/parsers'
import { controlJobs } from '../infra/sqlite/control-plane/schema'
import { eq } from 'drizzle-orm'
import type { JobAggregateView } from './ports/job-repository'
import type { RuntimeController } from './ports/runtime-controller'
import { JobCommandServiceImpl } from './job-command-service'
import { JobQueryServiceImpl, type JobDto, type JobQueryService } from './job-query-service'
import { SafeLoggerImpl } from './safe-logger'

export interface ControlPlaneAppContext {
  readonly db: AppDatabase
}

export interface ControlPlaneServices {
  readonly commandService: JobCommandService
  readonly queryService: JobQueryService
}

let cached: ControlPlaneServices | null = null

function createControlPlaneDb(appDb: AppDatabase): ControlPlaneDatabase {
  const client = (appDb as AppDatabase & { $client?: Database.Database }).$client
  if (!client) {
    throw new Error('Database client not available')
  }
  return drizzle(client, { schema: controlPlaneSchema })
}

function listJobAggregates(
  cpDb: ControlPlaneDatabase,
  projectId?: string
): readonly JobAggregateView[] {
  const base = cpDb
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

  const results =
    projectId !== undefined ? base.where(eq(controlJobs.projectId, projectId)).all() : base.all()

  return results.map((row) => ({
    id: row.id,
    threadId: row.threadId,
    projectId: row.projectId,
    state: parseJobState(row.state),
    stateRevision: row.stateRevision,
    controlIntent: parseControlIntent(row.controlIntent),
    resumeTarget: row.resumeTarget ? parseResumeTarget(row.resumeTarget) : null,
    currentPlanRevision: row.currentPlanRevision,
    executionGeneration: row.executionGeneration,
    activeRunId: row.activeRunId,
    lastFailureId: row.lastFailureId
  }))
}

const noopRuntimeController: RuntimeController = {
  notifyPauseRequested(jobId: string): void {
    console.info('[control-plane] pause requested', { jobId })
  },
  async closeThenRelease(runId: string, reason: string): Promise<void> {
    console.info('[control-plane] closeThenRelease', { runId, reason })
  }
}

export function getControlPlaneServices(ctx: ControlPlaneAppContext): ControlPlaneServices {
  if (cached !== null) {
    return cached
  }

  const cpDb = createControlPlaneDb(ctx.db)
  const jobRepository = new SqliteJobRepository(cpDb)
  const taskRepository = new SqliteTaskRepository(cpDb)
  const evidenceRepository = new EvidenceRepository(cpDb)
  const logger = new SafeLoggerImpl()

  const commandService = new JobCommandServiceImpl({
    jobRepository,
    taskRepository,
    evidenceRepository,
    clock: { nowMs: () => Date.now() },
    idGenerator: { generate: () => randomUUID() },
    logger,
    runtimeController: noopRuntimeController
  })

  const queryService = new JobQueryServiceImpl({
    getJobAggregate: (jobId: string) =>
      jobRepository.getOwnedAggregate({
        actor: { username: 'system', requestId: '' },
        jobId
      }),
    listJobAggregates: (projectId?: string) => listJobAggregates(cpDb, projectId),
    getJobTimestamps: (jobId: string) => jobRepository.getJobTimestamps(jobId)
  })

  cached = { commandService, queryService }
  return cached
}

/** True when `control_jobs` table exists (migration 027 applied). Safe for legacy-only DBs. */
export function controlJobsTableExists(ctx: ControlPlaneAppContext): boolean {
  try {
    const client = (ctx.db as AppDatabase & { $client?: Database.Database }).$client
    if (!client) return false
    const row = client
      .prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'control_jobs'`)
      .get() as { ok: number } | undefined
    return Boolean(row)
  } catch {
    return false
  }
}

/**
 * Safe try-get: returns null on legacy-only DBs or if control-plane services cannot be created.
 * Prefer this over getControlPlaneServices when dual-running with legacy jobs.
 */
export function tryGetControlPlaneServices(
  ctx: ControlPlaneAppContext
): ControlPlaneServices | null {
  if (!controlJobsTableExists(ctx)) {
    return null
  }
  try {
    return getControlPlaneServices(ctx)
  } catch {
    return null
  }
}

/**
 * Feature gate for C4/C5: only route through Command when a control_jobs row exists for jobId.
 * Legacy-only DBs and unmigrated jobs keep legacy controls behavior.
 */
export function tryGetControlJob(
  ctx: ControlPlaneAppContext,
  jobId: string,
  username = 'system'
): JobDto | null {
  const services = tryGetControlPlaneServices(ctx)
  if (services === null) return null
  try {
    return services.queryService.getJob(jobId, { username })
  } catch {
    return null
  }
}

/** Reset cached services (tests only). */
export function resetControlPlaneServicesForTests(): void {
  cached = null
}
