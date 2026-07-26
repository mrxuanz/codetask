/**
 * Workspace single-writer policy (Wave 6).
 * Scheduler and execute work must call this before claiming a workspace.
 */

export class WorkspaceSingleWriterError extends Error {
  readonly code = 'workspace.single_writer' as const

  constructor(message: string) {
    super(message)
    this.name = 'WorkspaceSingleWriterError'
  }
}

/**
 * @param workspaceId - workspace being claimed
 * @param holderId - job (or run) requesting exclusive write
 * @param currentHolderId - existing lease holder, or null/undefined if free
 */
export function assertSingleWriter(
  workspaceId: string,
  holderId: string,
  currentHolderId?: string | null
): void {
  if (!workspaceId || !holderId) {
    throw new WorkspaceSingleWriterError(
      'workspace.single_writer: workspaceId and holderId are required'
    )
  }
  if (currentHolderId != null && currentHolderId !== holderId) {
    throw new WorkspaceSingleWriterError(
      `workspace.single_writer: workspace ${workspaceId} held by ${currentHolderId}`
    )
  }
}
