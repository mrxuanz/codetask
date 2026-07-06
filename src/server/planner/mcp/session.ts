import { createHash } from 'crypto'
import type { PlannerRegisteredPlan, PlannerRegisteredTaskContext } from '../plan-types'
import type { JobReferenceManifest } from '@shared/job-references'

export interface PlannerMcpSession {
  sessionId: string
  jobId: string
  threadId: string

  allowedAbilityCodes: string[]
  validReferenceIds: string[]
  referenceManifest?: JobReferenceManifest | null
  taskContexts: Map<string, PlannerRegisteredTaskContext>
  registeredPlan: PlannerRegisteredPlan | null
  onTaskContextRegistered?: (key: string, done: number) => void
  onPlanRegistered?: (counts: { milestones: number; slices: number; tasks: number }) => void
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

export function buildPlannerMcpCapabilityToken(sessionId: string, jobId: string): string {
  const primary = createHash('sha256')
    .update(['planner', '1', sessionId, jobId].join('\0'))
    .digest('hex')
    .slice(0, 16)
  const secondary = createHash('sha256')
    .update(['planner', '2', sessionId, jobId].join('\0'))
    .digest('hex')
    .slice(0, 16)
  return `${primary}${secondary}`
}

export function authorizePlannerMcpRequest(input: {
  sessionId: string
  role?: string | null
  jobId?: string | null
  capability?: string | null
}): boolean {
  if (input.role?.trim() !== 'planner') return false
  const jobId = input.jobId?.trim()
  if (!jobId) return false
  const session = getPlannerMcpSession(input.sessionId)
  if (!session || session.jobId !== jobId) return false
  const expected = buildPlannerMcpCapabilityToken(input.sessionId, jobId)
  return input.capability?.trim() === expected
}

export function countExpectedTaskContexts(plan: PlannerRegisteredPlan | null): number {
  if (!plan) return 0
  let total = 0
  for (const milestone of plan.milestones) {
    for (const slice of milestone.slices) {
      total += slice.tasks.length
    }
  }
  return total
}
