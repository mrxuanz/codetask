export type Actor = {
  userId: string
  sessionId: string
  authRevision?: number
}

export class DesignConflictError extends Error {
  readonly code = 'design.conflict'
  constructor(message = 'Revision conflict') {
    super(message)
    this.name = 'DesignConflictError'
  }
}

export class DesignValidationError extends Error {
  readonly code = 'design.validation'
  constructor(message: string) {
    super(message)
    this.name = 'DesignValidationError'
  }
}

export class DesignNotFoundError extends Error {
  readonly code = 'design.not_found'
  constructor(message = 'Not found') {
    super(message)
    this.name = 'DesignNotFoundError'
  }
}

export class DesignForbiddenError extends Error {
  readonly code = 'design.forbidden'
  constructor(message = 'Forbidden') {
    super(message)
    this.name = 'DesignForbiddenError'
  }
}

export function nowMs(): number {
  return Date.now()
}

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '')}`
}

export function stableHash(input: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}
