export interface VersionedEntity<T> {
  readonly revision: number
  readonly entity: T
}

export type MergeDecision =
  | { readonly kind: 'ignore_stale' }
  | { readonly kind: 'accept'; readonly next: VersionedEntity<unknown> }
  | { readonly kind: 'resync'; readonly entityId: string }

export type SnapshotSource = 'incremental_event' | 'authoritative_snapshot'

export function reduceJobSnapshot(
  current: VersionedEntity<unknown> | undefined,
  incoming: { id: string; stateRevision: number },
  source: SnapshotSource
): MergeDecision {
  if (current === undefined) {
    return { kind: 'accept', next: { revision: incoming.stateRevision, entity: incoming } }
  }

  if (incoming.stateRevision < current.revision) {
    return { kind: 'ignore_stale' }
  }

  if (incoming.stateRevision === current.revision) {
    return deepEqual(incoming, current.entity)
      ? { kind: 'ignore_stale' }
      : { kind: 'resync', entityId: incoming.id }
  }

  if (incoming.stateRevision === current.revision + 1) {
    return { kind: 'accept', next: { revision: incoming.stateRevision, entity: incoming } }
  }

  if (source === 'authoritative_snapshot') {
    return { kind: 'accept', next: { revision: incoming.stateRevision, entity: incoming } }
  }

  return { kind: 'resync', entityId: incoming.id }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a == null || b == null) return false
  if (typeof a !== typeof b) return false
  if (typeof a !== 'object') return false

  const keysA = Object.keys(a as Record<string, unknown>)
  const keysB = Object.keys(b as Record<string, unknown>)
  if (keysA.length !== keysB.length) return false

  for (const key of keysA) {
    if (!keysB.includes(key)) return false
    if (!deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) return false
  }

  return true
}
