const MAX_FROZEN_ID_LEN = 128

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const ATTACHMENT_ID_RE = /^att-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export type FrozenIdKind = 'thread' | 'attachment'

export class FrozenIdError extends Error {
  constructor(
    readonly kind: FrozenIdKind,
    readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'FrozenIdError'
  }
}

function decodeTraversalAttempts(raw: string): string {
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

function assertNoTraversalSegments(raw: string, kind: FrozenIdKind): void {
  if (raw.includes('/') || raw.includes('\\')) {
    throw new FrozenIdError(kind, `${kind}.id_invalid`, `${kind} id must not contain path separators`)
  }
  const decoded = decodeTraversalAttempts(raw)
  if (decoded.includes('..') || decoded.includes('/') || decoded.includes('\\')) {
    throw new FrozenIdError(
      kind,
      `${kind}.id_invalid`,
      `${kind} id must not contain traversal segments`
    )
  }
  if (/%2e/i.test(raw) || /%2f/i.test(raw) || /%5c/i.test(raw)) {
    throw new FrozenIdError(
      kind,
      `${kind}.id_invalid`,
      `${kind} id must not contain encoded traversal`
    )
  }
}

function assertFrozenIdShape(raw: string, kind: FrozenIdKind, pattern: RegExp): string {
  const trimmed = raw.trim()
  if (!trimmed) {
    throw new FrozenIdError(kind, `${kind}.id_required`, `${kind} id is required`)
  }
  if (trimmed.length > MAX_FROZEN_ID_LEN) {
    throw new FrozenIdError(kind, `${kind}.id_invalid`, `${kind} id is too long`)
  }
  assertNoTraversalSegments(trimmed, kind)
  if (!pattern.test(trimmed)) {
    throw new FrozenIdError(kind, `${kind}.id_invalid`, `${kind} id has invalid format`)
  }
  return trimmed
}

export function assertFrozenThreadId(threadId: string): string {
  return assertFrozenIdShape(threadId, 'thread', UUID_RE)
}

export function assertFrozenAttachmentId(attachmentId: string): string {
  return assertFrozenIdShape(attachmentId, 'attachment', ATTACHMENT_ID_RE)
}
