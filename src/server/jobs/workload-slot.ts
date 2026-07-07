import { and, eq, type SQL } from 'drizzle-orm'
import { getAppContext } from '../bootstrap'
import { getDb } from '../db'
import { designSessions, threadJobs } from '../db/schema'
import type { WorkloadOwnerKind, WorkloadRunKind, WorkloadRunSummary } from './workload-slot-store'
import { findActiveWorkloadRunId, listActiveWorkloadSlots } from './workload-slot-store'

let startupWorkloadReady: Promise<void> = Promise.resolve()
let startupGateBound = false

export function bindStartupWorkloadGate(promise: Promise<void>): void {
  if (!startupGateBound) {
    startupWorkloadReady = promise
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
    .select({ id: designSessions.id })
    .from(designSessions)
    .where(and(eq(designSessions.username, username), eq(designSessions.status, 'planning')))
    .orderBy(designSessions.updatedAt)
    .limit(1)
  const id = rows[0]?.id ?? null
  if (!id) return null
  if (exceptId && id === exceptId) return null
  return id
}

export async function findActiveSlotOccupant(
  username: string,
  exceptId?: string
): Promise<string | null> {
  await ensureStartupWorkloadReady()
  const active = await listActiveWorkloadSlots({ username })
  for (const slot of active) {
    if (exceptId && slot.ownerId === exceptId) continue
    return slot.ownerId
  }
  return null
}

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
