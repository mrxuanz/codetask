/**
 * PR7: Isolated Workspace - Interface Reservation
 *
 * This file reserves the interface for isolated workspace support.
 * PR7 is NOT required for the first cutover.
 *
 * Production must NOT enter applying_changes until PR7 ships.
 *
 * Minimum support scope:
 * - Auto-create attempt workspace for clean Git projects
 * - Save source baseline (commit/hash/status)
 * - Worker only writes attempt, no .git metadata
 * - All task/verification passed before BeginWorkspaceApply
 * - Trusted parent generates manifest/patch
 * - Source changes -> failed/non-recoverable, preserve patch
 * - Writeback intent persisted for crash recovery
 */

export interface WorkspaceAttemptId {
  readonly jobId: string
  readonly attemptId: string
}

export interface IsolatedWorkspaceConfig {
  readonly enabled: boolean
  readonly capability: 'isolated_workspace_v1'
}

export class WorkspaceApplyRejectedError extends Error {
  readonly code = 'workspace.apply_reserved_pr7'

  constructor(jobId: string) {
    super(`beginWorkspaceApply rejected for job ${jobId} until PR7`)
    this.name = 'WorkspaceApplyRejectedError'
  }
}

export function isWorkspaceApplyAllowed(
  config: IsolatedWorkspaceConfig,
  _jobId: string
): boolean {
  return config.enabled && config.capability === 'isolated_workspace_v1'
}

/**
 * Reserved entry point for applying_changes. Throws until PR7 enables isolated workspace.
 */
export function beginWorkspaceApplyRejected(jobId: string): never {
  throw new WorkspaceApplyRejectedError(jobId)
}
