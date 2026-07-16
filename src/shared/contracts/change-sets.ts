/**
 * Change Set contracts (P6).
 * Isolated worktree edits that apply to the main workspace only under exclusive-write.
 */

export type ChangeSetStatus =
  | 'queued'
  | 'preparing_worktree'
  | 'editing'
  | 'validating'
  | 'ready_to_apply'
  | 'applying'
  | 'applied'
  | 'needs_resolution'
  | 'failed'
  | 'cancelled'

export interface ChangeSetDto {
  id: string
  projectId: string
  username: string
  sourceThreadId: string | null
  sourceTurnId: string | null
  status: ChangeSetStatus
  baseCommit: string | null
  baseWorkspaceGeneration: string | null
  worktreePath: string | null
  patchHash: string | null
  applyPolicy: string
  stateRevision: number
  lastError: { code: string; message: string } | null
  createdAt: number
  updatedAt: number
  appliedAt: number | null
}

export interface CreateChangeSetInput {
  projectId: string
  sourceThreadId?: string | null
  sourceTurnId?: string | null
  applyPolicy?: string
}

export interface CreateChangeSetAcceptedDto {
  changeSetId: string
  status: ChangeSetStatus
  revision: number
}
