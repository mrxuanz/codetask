/**
 * Workspace access capability levels.
 * Only `exclusive-write` may hold the main-project write lease.
 * `isolated-write` is for Change Set worktrees (never the main checkout).
 */
export type WorkspaceAccessMode =
  | 'metadata'
  | 'snapshot-read'
  | 'live-read'
  | 'isolated-write'
  | 'exclusive-write'

export function requiresExclusiveWorkspaceLease(mode: WorkspaceAccessMode): boolean {
  return mode === 'exclusive-write'
}

/** Conversation turns never write the real project directory. */
export function conversationWorkspaceAccess(
  needsProjectContext: boolean
): Extract<WorkspaceAccessMode, 'metadata' | 'live-read'> {
  return needsProjectContext ? 'live-read' : 'metadata'
}

/** Change Set workers write only their isolated worktree. */
export function changeSetWorkspaceAccess(): Extract<WorkspaceAccessMode, 'isolated-write'> {
  return 'isolated-write'
}
