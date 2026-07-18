import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import type { AppContext } from '../../../src/server/bootstrap'
import { bootstrapRuntime, resetAppContextForTests } from '../../../src/server/bootstrap'
import {
  bootstrapControlPlaneRuntime,
  getControlPlaneRuntime,
  resetControlPlaneRuntimeForTests,
  shutdownControlPlaneRuntime,
  startControlPlaneScheduler
} from '../../../src/server/application/control-plane-runtime'
import { createV3ApplicationRuntimeForTests } from '../../../src/server/application/application-runtime'
import {
  setCutoverMarkerForTests,
  type SchemaGeneration
} from '../../../src/server/application/cutover-state'
import { setAppCommitForTests } from '../../../scripts/control-plane/app-commit'
import { seedOwnedThreadJob } from '../fixtures/seed-owned-thread-job'

export function getSqliteClient(ctx: AppContext): Database.Database {
  const client = (ctx.db as AppContext['db'] & { $client?: Database.Database }).$client
  if (!client) throw new Error('sqlite client unavailable')
  return client
}

export function seedControlJob(
  db: Database.Database,
  opts: {
    readonly jobId?: string
    readonly username?: string
    readonly state?: string
    readonly stateRevision?: number
    readonly activeRunId?: string | null
    readonly executionGeneration?: number
  } = {}
): string {
  const jobId = opts.jobId ?? 'job-1'
  const username = opts.username ?? 'u1'
  const now = Date.now()
  seedOwnedThreadJob(db, {
    jobId,
    username,
    status: opts.state === 'execution_running' ? 'running' : 'pending'
  })
  db.prepare(
    `INSERT OR REPLACE INTO control_jobs (
      id, thread_id, project_id, draft_message_id, state, state_revision,
      control_intent, resume_target, current_plan_revision, execution_generation,
      active_run_id, last_failure_id, title, requirements_summary,
      created_at_ms, updated_at_ms, terminal_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, 'none', NULL, 1, ?, ?, NULL, ?, '', ?, ?, NULL)`
  ).run(
    jobId,
    `thread-${jobId}`,
    `project-${jobId}`,
    `draft-${jobId}`,
    opts.state ?? 'execution_queued',
    opts.stateRevision ?? 1,
    opts.executionGeneration ?? 0,
    opts.activeRunId ?? null,
    `Job ${jobId}`,
    now,
    now
  )
  return jobId
}

export function seedControlRun(
  db: Database.Database,
  opts: {
    readonly runId?: string
    readonly jobId?: string
    readonly kind?: string
    readonly state?: string
    readonly fenceToken?: string
    readonly executionGeneration?: number
  } = {}
): string {
  const runId = opts.runId ?? 'run-1'
  const now = Date.now()
  db.prepare(
    `INSERT OR REPLACE INTO control_job_runs (
      id, job_id, kind, state, attempt_no, fence_token, execution_generation, started_at_ms
    ) VALUES (?, ?, ?, ?, 1, ?, ?, ?)`
  ).run(
    runId,
    opts.jobId ?? 'job-1',
    opts.kind ?? 'execution',
    opts.state ?? 'active',
    opts.fenceToken ?? 'fence-1',
    opts.executionGeneration ?? 0,
    now
  )
  return runId
}

export function seedControlSlot(
  db: Database.Database,
  opts: {
    readonly slotId?: string
    readonly jobId?: string
    readonly runId?: string
    readonly state?: string
  } = {}
): string {
  const slotId = opts.slotId ?? 'slot-1'
  const now = Date.now()
  db.prepare(
    `INSERT OR REPLACE INTO control_resource_slots (
      id, job_id, run_id, pool, state, created_at_ms
    ) VALUES (?, ?, ?, 'default', ?, ?)`
  ).run(slotId, opts.jobId ?? 'job-1', opts.runId ?? 'run-1', opts.state ?? 'active', now)
  return slotId
}

export function countOpenSlots(db: Database.Database): number {
  return (
    db
      .prepare(`SELECT COUNT(*) AS count FROM control_resource_slots WHERE state != 'released'`)
      .get() as { count: number }
  ).count
}

export interface CompositionContextOptions {
  readonly generation: SchemaGeneration
  readonly seed?: (db: Database.Database) => void
}

/**
 * Boots an isolated composition context. Production bootstrap refuses v3_authoritative;
 * authoritative fixtures use the test-only V3 factory after a Legacy-safe bootstrap.
 */
export async function withCompositionContext(
  options: CompositionContextOptions,
  fn: (ctx: AppContext) => Promise<void>
): Promise<void> {
  let dataDir = ''
  let ctx: AppContext | undefined
  try {
    dataDir = mkdtempSync(join(tmpdir(), 'cp-composition-'))
    await resetAppContextForTests()
    const bootGeneration =
      options.generation === 'v3_authoritative' ? 'copied' : options.generation
    setCutoverMarkerForTests(bootGeneration)
    ctx = bootstrapRuntime({ dataDir })
    if (options.generation === 'v3_authoritative') {
      setCutoverMarkerForTests('v3_authoritative')
      ctx.applicationRuntime = createV3ApplicationRuntimeForTests(ctx)
    }
    const db = getSqliteClient(ctx)
    if (options.seed) {
      options.seed(db)
    }
    await fn(ctx)
  } finally {
    try {
      if (ctx !== undefined) {
        await shutdownControlPlaneRuntime('app_shutdown', ctx)
      }
    } catch {
      // runtime may not have started
    }
    if (ctx !== undefined) {
      await resetControlPlaneRuntimeForTests(ctx)
    }
    await resetAppContextForTests()
    setCutoverMarkerForTests(null)
    setAppCommitForTests(null)
    if (dataDir) {
      rmSync(dataDir, { recursive: true, force: true })
    }
  }
}

export async function bootAuthoritativeRuntime(
  ctx: AppContext,
  opts: { readonly startScheduler?: boolean } = {}
): Promise<void> {
  await bootstrapControlPlaneRuntime(ctx)
  if (opts.startScheduler) {
    await startControlPlaneScheduler(ctx)
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export { getControlPlaneRuntime, bootstrapControlPlaneRuntime, startControlPlaneScheduler }
