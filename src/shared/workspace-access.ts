/**
 * Workspace access capability levels.
 * Only `exclusive-write` may hold the main-project write lease.
 */
export type WorkspaceAccessMode = 'metadata' | 'snapshot-read' | 'live-read' | 'exclusive-write'

export function requiresExclusiveWorkspaceLease(mode: WorkspaceAccessMode): boolean {
  return mode === 'exclusive-write'
}

/** Default/fallback conversation access; ordinary chat may upgrade after acquiring a write lease. */
export function conversationWorkspaceAccess(
  needsProjectContext: boolean
): Extract<WorkspaceAccessMode, 'metadata' | 'live-read'> {
  return needsProjectContext ? 'live-read' : 'metadata'
}
