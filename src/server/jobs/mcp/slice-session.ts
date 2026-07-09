import { createHash } from 'crypto'
import { timingSafeStringEqual } from '../../auth/timing-safe'
import type { SliceVerificationVerdict } from '../verification/types'

export interface SliceVerifierMcpSession {
  sessionId: string
  jobId: string
  sliceId: string
  resolve: (verdict: SliceVerificationVerdict) => void
  reject: (error: Error) => void
}

const sessions = new Map<string, SliceVerifierMcpSession>()

export function registerSliceVerifierMcpSession(session: SliceVerifierMcpSession): void {
  sessions.set(session.sessionId, session)
}

export function unregisterSliceVerifierMcpSession(sessionId: string): void {
  sessions.delete(sessionId)
}

export function getSliceVerifierMcpSession(sessionId: string): SliceVerifierMcpSession | null {
  return sessions.get(sessionId) ?? null
}

export function buildSliceVerifierMcpCapabilityToken(
  sessionId: string,
  jobId: string,
  sliceId: string
): string {
  const primary = createHash('sha256')
    .update(['slice-verifier', '1', sessionId, jobId, sliceId].join('\0'))
    .digest('hex')
    .slice(0, 16)
  const secondary = createHash('sha256')
    .update(['slice-verifier', '2', sessionId, jobId, sliceId].join('\0'))
    .digest('hex')
    .slice(0, 16)
  return `${primary}${secondary}`
}

export function authorizeSliceVerifierMcpRequest(input: {
  sessionId: string
  role?: string | null
  jobId?: string | null
  sliceId?: string | null
  capability?: string | null
}): boolean {
  if (input.role?.trim() !== 'slice-verifier') return false
  const jobId = input.jobId?.trim()
  const sliceId = input.sliceId?.trim()
  if (!jobId || !sliceId) return false
  const session = getSliceVerifierMcpSession(input.sessionId)
  if (!session || session.jobId !== jobId || session.sliceId !== sliceId) return false
  return timingSafeStringEqual(
    input.capability?.trim(),
    buildSliceVerifierMcpCapabilityToken(input.sessionId, jobId, sliceId)
  )
}
