import { randomUUID } from 'crypto'
import { and, eq, sql } from 'drizzle-orm'
import { getDb } from '../db'
import { getAppContext } from '../bootstrap'
import { designSessions, threadJobs, workloadRuns, workloadSlots } from '../db/schema'

export type WorkloadOwnerKind = 'thread_job' | 'design_session'
export type WorkloadRunKind = 'planning' | 'execution'
export type WorkloadRunStatus = 'active' | 'cancelling' | 'stopping' | 'released' | 'failed'
export type WorkloadSlotStatus = 'active' | 'releasing' | 'released'

export interface ClaimWorkloadSlotInput {
  username: string
  ownerKind: WorkloadOwnerKind
  ownerId: string
  kind: WorkloadRunKind
  pool?: string
}

export interface ClaimedWorkloadRun {
  runId: string
  username: string
  ownerKind: WorkloadOwnerKind
  ownerId: string
  kind: WorkloadRunKind
  pool: string
  signal: AbortSignal
}

export interface ReleaseWorkloadSlotOptions {
  reason?: string
  skipQueueAdvance?: boolean
  status?: 'released' | 'failed'
}

export interface ReleaseWorkloadSlotResult {
  released: boolean
  username?: string
  ownerKind?: WorkloadOwnerKind
  ownerId?: string
}

export interface WorkloadRunSummary {
  runId: string
  username: string
  ownerKind: WorkloadOwnerKind
  ownerId: string
  kind: WorkloadRunKind
  pool: string
  status: WorkloadRunStatus
  leaseOwner: string | null
  leaseExpiresAt: number | null
  startedAt: number
  updatedAt: number
}

const runControllers = new Map<string, AbortController>()

function leaseOwner(): string {
  return `${process.pid}-${getAppContext().bootId}`
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000)
}

export function workloadPoolCapacity(pool = 'default'): number {
  const env = process.env.CODETASK_WORKLOAD_POOL_CAPACITY
  if (env) {
    const parsed = Number(env)
    if (!Number.isNaN(parsed) && parsed > 0) return parsed
  }
  return pool === 'execution' ? 1 : 1
}

export function workloadLeaseTtlSec(): number {
  const env = process.env.CODETASK_WORKLOAD_LEASE_TTL_SEC
  if (env) {
    const parsed = Number(env)
    if (!Number.isNaN(parsed) && parsed > 0) return parsed
  }
	  return 90 * 60
}

function ownerTable(ownerKind: WorkloadOwnerKind) {
  return ownerKind === 'thread_job' ? threadJobs : designSessions
}

function ownerIdColumn(ownerKind: WorkloadOwnerKind) {
  return ownerKind === 'thread_job' ? threadJobs.id : designSessions.id
}

export function getRunController(runId: string): AbortController | undefined {
  return runControllers.get(runId)
}

export function resetWorkloadRunControllersForTests(): void {
  for (const controller of runControllers.values()) {
    try {
      controller.abort()
    } catch {
      // ignore
    }
  }
  runControllers.clear()
}

export async function claimWorkloadSlotTx(
  input: ClaimWorkloadSlotInput
): Promise<ClaimedWorkloadRun | null> {
  const db = getDb()
  const username = input.username
  const ownerKind = input.ownerKind
  const ownerId = input.ownerId
  const kind = input.kind
  const pool = input.pool ?? 'default'
  const capacity = workloadPoolCapacity(pool)
  const now = nowSec()
  const owner = leaseOwner()
  const leaseExpiresAt = now + workloadLeaseTtlSec()

  const result = db.transaction((tx) => {
    const activeSlotCountRows = tx
      .select({ count: sql<number>`count(*)` })
      .from(workloadSlots)
      .where(
        and(
          eq(workloadSlots.username, username),
          eq(workloadSlots.pool, pool),
          eq(workloadSlots.status, 'active')
        )
      )
      .all()

    if (((activeSlotCountRows[0]?.count as number | undefined) ?? 0) >= capacity) {
      return null
    }

    const existingActiveRows = tx
      .select({ runId: workloadSlots.runId })
      .from(workloadSlots)
      .where(
        and(
          eq(workloadSlots.ownerKind, ownerKind),
          eq(workloadSlots.ownerId, ownerId),
          eq(workloadSlots.status, 'active')
        )
      )
      .all()

    if (existingActiveRows[0]) {
      return null
    }

    const runId = `wrun-${randomUUID()}`

    tx.insert(workloadRuns)
      .values({
        id: runId,
        username,
        ownerKind,
        ownerId,
        kind,
        pool,
        status: 'active',
        leaseOwner: owner,
        leaseExpiresAt,
        startedAt: now,
        updatedAt: now
      })
      .run()

    tx.insert(workloadSlots)
      .values({
        runId,
        username,
        pool,
        ownerKind,
        ownerId,
        kind,
        status: 'active',
        leaseOwner: owner,
        leaseExpiresAt,
        createdAt: now
      })
      .run()

    const ownerTableRef = ownerTable(ownerKind)
    const ownerIdCol = ownerIdColumn(ownerKind)

    tx.update(ownerTableRef)
      .set({ activeRunId: runId })
      .where(eq(ownerIdCol, ownerId))
      .run()

    return runId
  })

  if (!result) return null

  const controller = new AbortController()
  runControllers.set(result, controller)

  return {
    runId: result,
    username,
    ownerKind,
    ownerId,
    kind,
    pool,
    signal: controller.signal
  }
}

export async function releaseWorkloadSlot(
  runId: string,
  options: ReleaseWorkloadSlotOptions = {}
): Promise<ReleaseWorkloadSlotResult> {
  const db = getDb()
  const now = nowSec()
  const status = options.status ?? 'released'

  const result = db.transaction((tx) => {
    const runRow = tx
      .select()
      .from(workloadRuns)
      .where(eq(workloadRuns.id, runId))
      .limit(1)
      .all()[0]

    if (!runRow) {
      return { released: false }
    }

    if (runRow.status === 'released' || runRow.status === 'failed') {
      return {
        released: false,
        username: runRow.username,
        ownerKind: runRow.ownerKind as WorkloadOwnerKind,
        ownerId: runRow.ownerId
      }
    }

    tx.update(workloadRuns)
      .set({
        status,
        cancelReason: options.reason ?? runRow.cancelReason ?? null,
        updatedAt: now,
        releasedAt: now
      })
      .where(eq(workloadRuns.id, runId))
      .run()

    tx.update(workloadSlots)
      .set({
        status: 'released',
        releasedAt: now
      })
      .where(eq(workloadSlots.runId, runId))
      .run()

    const ownerKind = runRow.ownerKind as WorkloadOwnerKind
    const ownerTableRef = ownerTable(ownerKind)
    const ownerIdCol = ownerIdColumn(ownerKind)

    tx.update(ownerTableRef)
      .set({ activeRunId: null })
      .where(and(eq(ownerIdCol, runRow.ownerId), eq(ownerTableRef.activeRunId, runId)))
      .run()

    return {
      released: true,
      username: runRow.username,
      ownerKind,
      ownerId: runRow.ownerId
    }
  })

  if (result.released) {
    const controller = runControllers.get(runId)
    if (controller) {
      try {
        controller.abort(options.reason ?? 'release')
      } catch {
        // ignore
      }
      runControllers.delete(runId)
    }

    if (!options.skipQueueAdvance && result.username) {
      await advanceWorkloadQueue(result.username).catch((error) => {
        console.warn('[workload-slot] advance queue after release failed', runId, error)
      })
    }
  }

  return result
}

export async function getActiveRun(
  ownerKind: WorkloadOwnerKind,
  ownerId: string
): Promise<WorkloadRunSummary | null> {
  const db = getDb()
  const ownerTableRef = ownerTable(ownerKind)
  const ownerIdCol = ownerIdColumn(ownerKind)

  const ownerRow = await db
    .select({ activeRunId: ownerTableRef.activeRunId })
    .from(ownerTableRef)
    .where(eq(ownerIdCol, ownerId))
    .limit(1)
    .then((rows) => rows[0] ?? null)

  if (!ownerRow?.activeRunId) return null

  const runRow = await db
    .select()
    .from(workloadRuns)
    .where(eq(workloadRuns.id, ownerRow.activeRunId))
    .limit(1)
    .then((rows) => rows[0] ?? null)

  if (!runRow || runRow.status === 'released' || runRow.status === 'failed') return null

  return {
    runId: runRow.id,
    username: runRow.username,
    ownerKind: runRow.ownerKind as WorkloadOwnerKind,
    ownerId: runRow.ownerId,
    kind: runRow.kind as WorkloadRunKind,
    pool: runRow.pool,
    status: runRow.status as WorkloadRunStatus,
    leaseOwner: runRow.leaseOwner,
    leaseExpiresAt: runRow.leaseExpiresAt,
    startedAt: runRow.startedAt,
    updatedAt: runRow.updatedAt
  }
}

export async function assertRunActive(
  ownerKind: WorkloadOwnerKind,
  ownerId: string,
  runId: string
): Promise<boolean> {
  const active = await getActiveRun(ownerKind, ownerId)
  return active?.runId === runId
}

export async function assertRunWritable(
  ownerKind: WorkloadOwnerKind,
  ownerId: string,
  runId: string
): Promise<boolean> {
  const db = getDb()
  const ownerTableRef = ownerTable(ownerKind)
  const ownerIdCol = ownerIdColumn(ownerKind)

  const ownerRow = await db
    .select({ activeRunId: ownerTableRef.activeRunId })
    .from(ownerTableRef)
    .where(eq(ownerIdCol, ownerId))
    .limit(1)
    .then((rows) => rows[0] ?? null)

  if (ownerRow?.activeRunId !== runId) return false

  const runRow = await db
    .select({ status: workloadRuns.status })
    .from(workloadRuns)
    .where(eq(workloadRuns.id, runId))
    .limit(1)
    .then((rows) => rows[0] ?? null)

  return runRow?.status === 'active'
}

export async function clearActiveRunIfMatches(
  ownerKind: WorkloadOwnerKind,
  ownerId: string,
  runId: string
): Promise<void> {
  const db = getDb()
  const ownerTableRef = ownerTable(ownerKind)
  const ownerIdCol = ownerIdColumn(ownerKind)

  await db
    .update(ownerTableRef)
    .set({ activeRunId: null })
    .where(and(eq(ownerIdCol, ownerId), eq(ownerTableRef.activeRunId, runId)))
    .run()
}

export async function markRunCancelling(
  runId: string,
  reason: string
): Promise<WorkloadRunSummary | null> {
  const db = getDb()
  const now = nowSec()

  const runRow = await db
    .select()
    .from(workloadRuns)
    .where(eq(workloadRuns.id, runId))
    .limit(1)
    .then((rows) => rows[0] ?? null)

  if (!runRow || runRow.status === 'released' || runRow.status === 'failed') return null

  await db
    .update(workloadRuns)
    .set({ status: 'cancelling', cancelReason: reason, updatedAt: now })
    .where(eq(workloadRuns.id, runId))
    .run()

  return {
    runId: runRow.id,
    username: runRow.username,
    ownerKind: runRow.ownerKind as WorkloadOwnerKind,
    ownerId: runRow.ownerId,
    kind: runRow.kind as WorkloadRunKind,
    pool: runRow.pool,
    status: 'cancelling',
    leaseOwner: runRow.leaseOwner,
    leaseExpiresAt: runRow.leaseExpiresAt,
    startedAt: runRow.startedAt,
    updatedAt: now
  }
}

export async function refreshWorkloadLease(runId: string): Promise<void> {
  const db = getDb()
  const now = nowSec()
  const owner = leaseOwner()
  const leaseExpiresAt = now + workloadLeaseTtlSec()

  await db
    .update(workloadRuns)
    .set({ leaseOwner: owner, leaseExpiresAt, updatedAt: now })
    .where(eq(workloadRuns.id, runId))
    .run()

  await db
    .update(workloadSlots)
    .set({ leaseOwner: owner, leaseExpiresAt })
    .where(eq(workloadSlots.runId, runId))
    .run()
}

export async function listActiveWorkloadSlots(
  filter: {
    username?: string
    pool?: string
  } = {}
): Promise<WorkloadRunSummary[]> {
  const db = getDb()
  const conditions = [eq(workloadSlots.status, 'active')]
  if (filter.username) {
    conditions.push(eq(workloadSlots.username, filter.username))
  }
  if (filter.pool) {
    conditions.push(eq(workloadSlots.pool, filter.pool))
  }

  const rows = await db
    .select({
      runId: workloadSlots.runId,
      username: workloadSlots.username,
      ownerKind: workloadSlots.ownerKind,
      ownerId: workloadSlots.ownerId,
      kind: workloadSlots.kind,
      pool: workloadSlots.pool,
      status: workloadRuns.status,
      leaseOwner: workloadSlots.leaseOwner,
      leaseExpiresAt: workloadSlots.leaseExpiresAt,
      startedAt: workloadRuns.startedAt,
      updatedAt: workloadRuns.updatedAt
    })
    .from(workloadSlots)
    .innerJoin(workloadRuns, eq(workloadSlots.runId, workloadRuns.id))
    .where(and(...conditions))
    .orderBy(workloadRuns.startedAt)
    .then((rows) =>
      rows.map((row) => ({
        runId: row.runId,
        username: row.username,
        ownerKind: row.ownerKind as WorkloadOwnerKind,
        ownerId: row.ownerId,
        kind: row.kind as WorkloadRunKind,
        pool: row.pool,
        status: row.status as WorkloadRunStatus,
        leaseOwner: row.leaseOwner,
        leaseExpiresAt: row.leaseExpiresAt,
        startedAt: row.startedAt,
        updatedAt: row.updatedAt
      }))
    )

  return rows
}

export async function isRunActive(runId: string): Promise<boolean> {
  const db = getDb()
  const row = await db
    .select({ status: workloadRuns.status, ownerKind: workloadRuns.ownerKind, ownerId: workloadRuns.ownerId })
    .from(workloadRuns)
    .where(eq(workloadRuns.id, runId))
    .limit(1)
    .then((rows) => rows[0] ?? null)

  if (!row || row.status === 'released' || row.status === 'failed') return false
  return assertRunActive(row.ownerKind as WorkloadOwnerKind, row.ownerId, runId)
}

export async function findActiveWorkloadRunId(
  ownerKind: WorkloadOwnerKind,
  ownerId: string
): Promise<string | null> {
  const active = await getActiveRun(ownerKind, ownerId)
  return active?.runId ?? null
}

export async function updateRunRuntimeRef(runId: string, ref: unknown): Promise<void> {
  const db = getDb()
  await db
    .update(workloadRuns)
    .set({ runtimeRefJson: JSON.stringify(ref), updatedAt: nowSec() })
    .where(eq(workloadRuns.id, runId))
    .run()
}

const executionRunIds = new Map<string, string>()

export function setExecutionRunId(jobId: string, runId: string): void {
  executionRunIds.set(jobId, runId)
}

export function getExecutionRunId(jobId: string): string | undefined {
  return executionRunIds.get(jobId)
}

export function clearExecutionRunId(jobId: string): void {
  executionRunIds.delete(jobId)
}

export function resetExecutionRunIdsForTests(): void {
  executionRunIds.clear()
}

export async function claimExecutionWorkloadSlot(
  username: string,
  jobId: string
): Promise<{ runId: string; signal: AbortSignal } | null> {
  const run = await claimWorkloadSlotTx({
    username,
    ownerKind: 'thread_job',
    ownerId: jobId,
    kind: 'execution',
    pool: 'execution'
  })
  if (!run) return null
  setExecutionRunId(jobId, run.runId)
  return { runId: run.runId, signal: run.signal }
}

export async function releaseExecutionWorkloadSlot(
  jobId: string,
  reason = 'execution_done'
): Promise<void> {
  const runId = executionRunIds.get(jobId)
  if (!runId) return
  clearExecutionRunId(jobId)
  await releaseWorkloadSlot(runId, { reason })
}

export async function getRunRuntimeRef<T = unknown>(runId: string): Promise<T | null> {
  const db = getDb()
  const row = await db
    .select({ runtimeRefJson: workloadRuns.runtimeRefJson })
    .from(workloadRuns)
    .where(eq(workloadRuns.id, runId))
    .limit(1)
    .then((rows) => rows[0] ?? null)

  if (!row?.runtimeRefJson) return null
  try {
    return JSON.parse(row.runtimeRefJson) as T
  } catch {
    return null
  }
}

export async function releaseActiveRunForOwner(
  ownerKind: WorkloadOwnerKind,
  ownerId: string,
  reason: string
): Promise<{ released: boolean; runId?: string; username?: string }> {
  const active = await getActiveRun(ownerKind, ownerId)
  if (!active) return { released: false }
  const result = await releaseWorkloadSlot(active.runId, { reason })
  return {
    released: result.released,
    runId: active.runId,
    username: result.username ?? active.username
  }
}

export async function stopAndReleaseActiveRun(
  ownerKind: WorkloadOwnerKind,
  ownerId: string,
  reason: string
): Promise<{ runId?: string; released: boolean }> {
  return stopAndReleaseActiveRunSync(ownerKind, ownerId, reason)
}

export async function stopAndReleaseActiveRunSync(
  ownerKind: WorkloadOwnerKind,
  ownerId: string,
  reason: string
): Promise<{ runId?: string; released: boolean }> {
  const active = await getActiveRun(ownerKind, ownerId)
  if (!active) return { released: false }

  const { stopRunLifecycle } = await import('./run-lifecycle')
  await stopRunLifecycle(active.runId, reason)
  return { runId: active.runId, released: true }
}

export async function releaseActiveRunOrAdvanceQueue(
  username: string,
  ownerKind: WorkloadOwnerKind,
  ownerId: string,
  reason: string
): Promise<void> {
  const stopped = await stopAndReleaseActiveRun(ownerKind, ownerId, reason)
  if (!stopped.released) {
    await advanceWorkloadQueue(username).catch((error) => {
      console.warn('[workload-slot] fallback advance queue failed', username, error)
    })
  }
}

/** Single queue-advance exit: pending thread jobs, then slot-waiting design sessions. */
export async function advanceWorkloadQueue(username: string): Promise<void> {
  const { advanceAllQueues } = await import('./queue-coordinator')
  await advanceAllQueues(username)
}
