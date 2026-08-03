import { createHash } from 'node:crypto'

export function buildPlannerMcpCapabilityToken(
  sessionId: string,
  planningSessionId: string
): string {
  const primary = createHash('sha256')
    .update(['planner', '1', sessionId, planningSessionId].join('\0'))
    .digest('hex')
    .slice(0, 16)
  const secondary = createHash('sha256')
    .update(['planner', '2', sessionId, planningSessionId].join('\0'))
    .digest('hex')
    .slice(0, 16)
  return `${primary}${secondary}`
}

export function verifyPlannerMcpCapabilityToken(
  capability: string | null | undefined,
  sessionId: string,
  planningSessionId: string
): boolean {
  if (!capability?.trim()) return false
  return buildPlannerMcpCapabilityToken(sessionId, planningSessionId) === capability.trim()
}
