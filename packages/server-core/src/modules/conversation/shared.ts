export type Actor = {
  userId: string
  sessionId: string
}

export class ConversationConflictError extends Error {
  readonly code = 'conversation.conflict'
  constructor(message: string) {
    super(message)
    this.name = 'ConversationConflictError'
  }
}

export class ConversationValidationError extends Error {
  readonly code = 'conversation.validation'
  constructor(message: string) {
    super(message)
    this.name = 'ConversationValidationError'
  }
}

export class ConversationNotFoundError extends Error {
  readonly code = 'conversation.not_found'
  constructor(message = 'Not found') {
    super(message)
    this.name = 'ConversationNotFoundError'
  }
}

export class ConversationForbiddenError extends Error {
  readonly code = 'conversation.forbidden'
  constructor(message = 'Forbidden') {
    super(message)
    this.name = 'ConversationForbiddenError'
  }
}

export function nowIso(): string {
  return new Date().toISOString()
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
