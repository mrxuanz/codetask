import { createHash } from 'crypto'
import { timingSafeStringEqual } from '../../auth/timing-safe'
import type { TaskEvidencePacket } from '../evidence/normalize'

export type { TaskEvidencePacket }

export interface TaskMcpSession {
  sessionId: string
  jobId: string
  taskId: string
  /** Stable logical-task identity; bound into the capability URL. */
  idempotencyKey: string
  resolve: (packet: TaskEvidencePacket) => void
  reject: (error: Error) => void
}

const sessions = new Map<string, TaskMcpSession>()

export function registerTaskMcpSession(session: TaskMcpSession): void {
  sessions.set(session.sessionId, session)
}

export function unregisterTaskMcpSession(sessionId: string): void {
  sessions.delete(sessionId)
}

export function getTaskMcpSession(sessionId: string): TaskMcpSession | null {
  return sessions.get(sessionId) ?? null
}

export function buildTaskMcpCapabilityToken(
  sessionId: string,
  jobId: string,
  taskId: string,
  idempotencyKey: string
): string {
  const primary = createHash('sha256')
    .update(['task-worker', '1', sessionId, jobId, taskId, idempotencyKey].join('\0'))
    .digest('hex')
    .slice(0, 16)
  const secondary = createHash('sha256')
    .update(['task-worker', '2', sessionId, jobId, taskId, idempotencyKey].join('\0'))
    .digest('hex')
    .slice(0, 16)
  return `${primary}${secondary}`
}

export function authorizeTaskMcpRequest(input: {
  sessionId: string
  role?: string | null
  jobId?: string | null
  taskId?: string | null
  idempotencyKey?: string | null
  capability?: string | null
}): boolean {
  if (input.role?.trim() !== 'task-worker') return false
  const jobId = input.jobId?.trim()
  const taskId = input.taskId?.trim()
  const idempotencyKey = input.idempotencyKey?.trim()
  if (!jobId || !taskId || !idempotencyKey) return false
  const session = getTaskMcpSession(input.sessionId)
  if (
    !session ||
    session.jobId !== jobId ||
    session.taskId !== taskId ||
    session.idempotencyKey !== idempotencyKey
  ) {
    return false
  }
  const expected = buildTaskMcpCapabilityToken(input.sessionId, jobId, taskId, idempotencyKey)
  return timingSafeStringEqual(input.capability?.trim(), expected)
}
