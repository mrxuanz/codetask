import { and, eq, type SQL } from 'drizzle-orm'
import { getAppContext } from '../bootstrap'
import { getDb } from '../db'
import { threadJobs } from '../db/schema'
import type { WorkloadOwnerKind, WorkloadRunKind, WorkloadRunSummary } from './workload-slot-store'
import { findActiveWorkloadRunId, listActiveWorkloadSlots } from './workload-slot-store'

let startupWorkloadReady: Promise<void> = Promise.resolve()
let startupGateBound = false

const STARTUP_GATE_TIMEOUT_MS = 30_000

export function bindStartupWorkloadGate(promise: Promise<void>): void {
  if (!startupGateBound) {
    startupWorkloadReady = Promise.race([
      promise,
      new Promise<void>((_, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`startup workload reconcile exceeded ${STARTUP_GATE_TIMEOUT_MS}ms`))
        }, STARTUP_GATE_TIMEOUT_MS)
        timer.unref?.()
      })
    ])
    startupGateBound = true
  }
}

export async function ensureStartupWorkloadReady(): Promise<void> {
  await startupWorkloadReady
}

export function resetStartupWorkloadGateForTests(): void {
  startupWorkloadReady = Promise.resolve()
  startupGateBound = false
}

export function anyRunningJobClause(username: string): SQL<unknown> | undefined {
  return and(eq(threadJobs.username, username), eq(threadJobs.status, 'running'))
}

export function findInMemoryExecutionOccupant(
  username: string,
  exceptJobId?: string
): string | null {
  try {
    return getAppContext().executionRuntime.findActiveLoopJobIdForUser(username, exceptJobId)
  } catch {
    return null
  }
}

export function findInMemoryPlanningOccupant(username: string, exceptId?: string): string | null {
  try {
    return getAppContext().runtimeRegistry.findActivePlanningIdForUser(username, exceptId)
  } catch {
    return null
  }
}

export function isWorkloadBlockedInMemory(username: string, exceptId?: string): boolean {
  return Boolean(
    findInMemoryExecutionOccupant(username, exceptId) ||
      findInMemoryPlanningOccupant(username, exceptId)
  )
}

export async function findDbRunningJobId(
  username: string,
  exceptJobId?: string
): Promise<string | null> {
  const rows = await getDb()
    .select({ id: threadJobs.id })
    .from(threadJobs)
    .where(anyRunningJobClause(username))
    .orderBy(threadJobs.updatedAt)
    .limit(1)
  const id = rows[0]?.id ?? null
  if (!id) return null
  if (exceptJobId && id === exceptJobId) return null
  return id
}

export async function findDbPlanningSessionId(
  username: string,
  exceptId?: string
): Promise<string | null> {
  const rows = await getDb()
    .select({ id: threadJobs.id })
    .from(threadJobs)
    .where(
      and(
        eq(threadJobs.username, username),
        eq(threadJobs.status, 'planning'),
        // Waiting-for-slot jobs keep status=planning with planStatus=pending.
        // They must not count as occupants or advancePlanningQueue never starts them.
        eq(threadJobs.planStatus, 'running')
      )
    )
    .orderBy(threadJobs.updatedAt)
    .limit(1)
  const id = rows[0]?.id ?? null
  if (!id) return null
  if (exceptId && id === exceptId) return null
  return id
}

export function workloadLeaseOwner(): string {
  // Must match workload-slot-store leaseOwner() (`${pid}-${bootId}`).
  return `${process.pid}-${getAppContext().bootId}`
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000)
}

export function isWorkloadSlotLeaseLive(slot: WorkloadRunSummary): boolean {
  const currentPid = slot.leaseOwner === workloadLeaseOwner()
  const leaseValid = slot.leaseExpiresAt ? slot.leaseExpiresAt > nowSec() : false
  return currentPid && leaseValid
}

export async function findActiveSlotOccupant(
  username: string,
  exceptId?: string
): Promise<string | null> {
  await ensureStartupWorkloadReady()
  const active = await listActiveWorkloadSlots({ username })
  for (const slot of active) {
    if (exceptId && slot.ownerId === exceptId) continue
    if (!isWorkloadSlotLeaseLive(slot)) continue
    return slot.ownerId
  }
  return null
}

export async function findActiveSlotOccupantInPool(
  username: string,
  pool: string,
  exceptId?: string
): Promise<string | null> {
  await ensureStartupWorkloadReady()
  const active = await listActiveWorkloadSlots({ username, pool })
  for (const slot of active) {
    if (exceptId && slot.ownerId === exceptId) continue
    if (!isWorkloadSlotLeaseLive(slot)) continue
    return slot.ownerId
  }
  return null
}

export async function findExecutionOccupant(
  username: string,
  exceptJobId?: string
): Promise<string | null> {
  await ensureStartupWorkloadReady()

  const memExec = findInMemoryExecutionOccupant(username, exceptJobId)
  if (memExec) return memExec

  const slotOccupant = await findActiveSlotOccupantInPool(username, 'execution', exceptJobId)
  if (slotOccupant) return slotOccupant

  const dbExec = await findDbRunningJobId(username, exceptJobId)
  if (dbExec) return dbExec

  return null
}

export async function findPlanningOccupant(
  username: string,
  exceptId?: string
): Promise<string | null> {
  await ensureStartupWorkloadReady()

  const memPlan = findInMemoryPlanningOccupant(username, exceptId)
  if (memPlan) return memPlan

  const slotOccupant = await findActiveSlotOccupantInPool(username, 'planning', exceptId)
  if (slotOccupant) return slotOccupant

  const dbPlan = await findDbPlanningSessionId(username, exceptId)
  if (dbPlan) return dbPlan

  return null
}

/**
 * @deprecated Use findExecutionOccupant or findPlanningOccupant instead.
 * This checks ALL pools and is only retained for diagnostic APIs.
 */
export async function findWorkloadOccupant(
  username: string,
  exceptId?: string
): Promise<string | null> {
  await ensureStartupWorkloadReady()

  const memExec = findInMemoryExecutionOccupant(username, exceptId)
  if (memExec) return memExec

  const memPlan = findInMemoryPlanningOccupant(username, exceptId)
  if (memPlan) return memPlan

  const slotOccupant = await findActiveSlotOccupant(username, exceptId)
  if (slotOccupant) return slotOccupant

  const dbExec = await findDbRunningJobId(username, exceptId)
  if (dbExec) return dbExec

  const dbPlan = await findDbPlanningSessionId(username, exceptId)
  if (dbPlan) return dbPlan

  return null
}

export async function findOccupyingRun(
  username: string,
  exceptId?: string
): Promise<WorkloadRunSummary | null> {
  await ensureStartupWorkloadReady()
  const active = await listActiveWorkloadSlots({ username })
  for (const slot of active) {
    if (exceptId && slot.ownerId === exceptId) continue
    if (!isWorkloadSlotLeaseLive(slot)) continue
    return slot
  }
  return null
}

export async function findActiveRunForOwner(
  ownerKind: WorkloadOwnerKind,
  ownerId: string
): Promise<WorkloadRunSummary | null> {
  await ensureStartupWorkloadReady()
  const runId = await findActiveWorkloadRunId(ownerKind, ownerId)
  if (!runId) return null
  const active = await listActiveWorkloadSlots({})
  return active.find((s) => s.runId === runId) ?? null
}

export async function isOwnerRunning(
  ownerKind: WorkloadOwnerKind,
  ownerId: string,
  kind?: WorkloadRunKind
): Promise<boolean> {
  const active = await findActiveRunForOwner(ownerKind, ownerId)
  if (!active) return false
  if (kind) return active.kind === kind
  return true
}
