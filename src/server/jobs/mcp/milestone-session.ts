import { createHash } from 'crypto'
import type { MilestoneVerificationVerdict } from '../verification/types'

export interface MilestoneVerifierMcpSession {
  sessionId: string
  jobId: string
  milestoneId: string
  resolve: (verdict: MilestoneVerificationVerdict) => void
  reject: (error: Error) => void
}

const sessions = new Map<string, MilestoneVerifierMcpSession>()

export function registerMilestoneVerifierMcpSession(session: MilestoneVerifierMcpSession): void {
  sessions.set(session.sessionId, session)
}

export function unregisterMilestoneVerifierMcpSession(sessionId: string): void {
  sessions.delete(sessionId)
}

export function getMilestoneVerifierMcpSession(
  sessionId: string
): MilestoneVerifierMcpSession | null {
  return sessions.get(sessionId) ?? null
}

export function buildMilestoneVerifierMcpCapabilityToken(
  sessionId: string,
  jobId: string,
  milestoneId: string
): string {
  const primary = createHash('sha256')
    .update(['milestone-verifier', '1', sessionId, jobId, milestoneId].join('\0'))
    .digest('hex')
    .slice(0, 16)
  const secondary = createHash('sha256')
    .update(['milestone-verifier', '2', sessionId, jobId, milestoneId].join('\0'))
    .digest('hex')
    .slice(0, 16)
  return `${primary}${secondary}`
}

export function authorizeMilestoneVerifierMcpRequest(input: {
  sessionId: string
  role?: string | null
  jobId?: string | null
  milestoneId?: string | null
  capability?: string | null
}): boolean {
  if (input.role?.trim() !== 'milestone-verifier') return false
  const jobId = input.jobId?.trim()
  const milestoneId = input.milestoneId?.trim()
  if (!jobId || !milestoneId) return false
  const session = getMilestoneVerifierMcpSession(input.sessionId)
  if (!session || session.jobId !== jobId || session.milestoneId !== milestoneId) return false
  return (
    input.capability?.trim() ===
    buildMilestoneVerifierMcpCapabilityToken(input.sessionId, jobId, milestoneId)
  )
}
