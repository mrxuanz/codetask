/**
 * Workspace access capability levels.
 * Only `exclusive-write` may hold the main-project write lease.
 */
export type WorkspaceAccessMode = 'metadata' | 'snapshot-read' | 'live-read' | 'exclusive-write'

/**
 * Opaque proof that the application control plane granted one Job exclusive
 * ownership of a workspace. The sandbox validates the identity again before
 * adding the real workspace to its write roots.
 */
export interface WorkspaceWriteLease {
  readonly leaseId: string
  readonly ownerKind: 'job'
  readonly ownerId: string
}

export function requiresExclusiveWorkspaceLease(mode: WorkspaceAccessMode): boolean {
  return mode === 'exclusive-write'
}

/** Default/fallback conversation access; ordinary chat may upgrade after acquiring a write lease. */
export function conversationWorkspaceAccess(
  needsProjectContext: boolean
): Extract<WorkspaceAccessMode, 'metadata' | 'live-read'> {
  return needsProjectContext ? 'live-read' : 'metadata'
}
