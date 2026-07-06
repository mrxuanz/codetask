import { and, asc, eq, type SQL } from 'drizzle-orm'
import { getAppContext } from '../bootstrap'
import { getDb } from '../db'
import { designSessions, threadJobs } from '../db/schema'

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
    .orderBy(asc(threadJobs.updatedAt))
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
    .orderBy(asc(designSessions.updatedAt))
    .limit(1)
  const id = rows[0]?.id ?? null
  if (!id) return null
  if (exceptId && id === exceptId) return null
  return id
}

/** Returns occupant id (execution job id or design session id) if user workload slot is taken. */
export async function findWorkloadOccupant(
  username: string,
  exceptId?: string
): Promise<string | null> {
  await ensureStartupWorkloadReady()

  const memExec = findInMemoryExecutionOccupant(username, exceptId)
  if (memExec) return memExec

  const memPlan = findInMemoryPlanningOccupant(username, exceptId)
  if (memPlan) return memPlan

  const dbExec = await findDbRunningJobId(username, exceptId)
  if (dbExec) return dbExec

  const dbPlan = await findDbPlanningSessionId(username, exceptId)
  if (dbPlan) return dbPlan

  return null
}
