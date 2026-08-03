import type { DraftSnapshot, ReferenceManifest } from '@codetask/contracts'
import type { PlanningApplicationPort } from '../application/planning-application.ts'
import { verifyPlannerMcpCapabilityToken } from './capability.ts'
import type { PlannerRegisteredPlan, PlannerRegisteredTaskContext } from './types.ts'

export interface PlannerMcpSession {
  sessionId: string
  /** Design planning_sessions.id */
  planningSessionId: string
  runId: string
  fencingToken: string
  allowedAbilityCodes: string[]
  validReferenceIds: string[]
  draftSnapshot: DraftSnapshot
  referenceManifest: ReferenceManifest
  defaultCoreCode: string
  planning: PlanningApplicationPort
  taskContexts: Map<string, PlannerRegisteredTaskContext>
  planOutline: PlannerRegisteredPlan | null
  planCommitted?: boolean | undefined
  planCommitting?: boolean | undefined
  finalizerPromise?: Promise<void> | undefined
  finalizerError?: Error | undefined
  operationQueue?: Promise<void> | undefined
  abortTurn?: (() => void) | undefined
  onTaskContextRegistered?: ((key: string, done: number) => Promise<void>) | undefined
  onPlanOutlineRegistered?:
    | ((counts: { milestones: number; slices: number; tasks: number }) => Promise<void>)
    | undefined
}

const sessions = new Map<string, PlannerMcpSession>()

export function registerPlannerMcpSession(session: PlannerMcpSession): void {
  sessions.set(session.sessionId, session)
}

export function unregisterPlannerMcpSession(sessionId: string): void {
  sessions.delete(sessionId)
}

export function getPlannerMcpSession(sessionId: string): PlannerMcpSession | null {
  return sessions.get(sessionId) ?? null
}

export function authorizePlannerMcpRequest(input: {
  sessionId: string
  role?: string | null
  planningSessionId?: string | null
  capability?: string | null
}): boolean {
  if (input.role?.trim() !== 'planner') return false
  const planningSessionId = input.planningSessionId?.trim()
  if (!planningSessionId) return false
  const session = getPlannerMcpSession(input.sessionId)
  if (!session || session.planningSessionId !== planningSessionId) return false
  return verifyPlannerMcpCapabilityToken(input.capability, input.sessionId, planningSessionId)
}

export function countExpectedTaskContexts(outline: PlannerRegisteredPlan | null): number {
  if (!outline) return 0
  let total = 0
  for (const milestone of outline.milestones) {
    for (const slice of milestone.slices) {
      total += slice.tasks.length
    }
  }
  return total
}

/** Plan may commit via MCP finalizer while the agent turn is still ending (abortTurn). */
export function isPlannerPlanCommitted(
  planCommitted: boolean,
  session?: Pick<PlannerMcpSession, 'planCommitted'> | null
): boolean {
  return planCommitted || Boolean(session?.planCommitted)
}
