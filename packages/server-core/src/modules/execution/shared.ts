import path from 'node:path'
import { createHash } from 'node:crypto'

export type Actor = {
  userId: string
  sessionId: string
  authRevision?: number
}

export class ExecutionConflictError extends Error {
  readonly code = 'execution.conflict'
  constructor(message = 'Conflict') {
    super(message)
    this.name = 'ExecutionConflictError'
  }
}

export class ExecutionValidationError extends Error {
  readonly code = 'execution.validation'
  constructor(message: string) {
    super(message)
    this.name = 'ExecutionValidationError'
  }
}

export class ExecutionNotFoundError extends Error {
  readonly code = 'execution.not_found'
  constructor(message = 'Not found') {
    super(message)
    this.name = 'ExecutionNotFoundError'
  }
}

export class ExecutionForbiddenError extends Error {
  readonly code = 'execution.forbidden'
  constructor(message = 'Forbidden') {
    super(message)
    this.name = 'ExecutionForbiddenError'
  }
}

export function nowMs(): number {
  return Date.now()
}

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '')}`
}

export function stableHash(input: string): string {
  return createHash('sha256').update(input).digest('hex')
}

export function canonicalizeWorkspaceRoot(workspaceRoot: string): string {
  return path.normalize(workspaceRoot)
}

export function isoFromMs(ms: number): string {
  return new Date(ms).toISOString()
}

export const LEASE_TTL_MS = 60_000
export const EXECUTION_POOL = 'job-execution'
export const EXECUTION_SLOT = 1
