import type { WorkspaceAccessMode } from '../../../shared/workspace-access.ts'
import type { AgentCapabilityProfile } from '../../agent-runtime/capabilities'
import type { WorkspaceLeaseOwnerKind } from '../../legacy-control-plane/workspace-lease-store'

/** Lease held by an ordinary chat turn while it has exclusive write access. */
export interface ConversationWorkspaceLease {
  leaseId: string
  ownerKind: Extract<WorkspaceLeaseOwnerKind, 'conversation'>
  ownerId: string
}

/**
 * Workspace + capability decision for one conversation turn.
 * Chat and create-task resolve this independently — never share one hard-coded path.
 */
export interface ConversationAccessDecision {
  workspaceAccess: WorkspaceAccessMode
  capabilityProfile: AgentCapabilityProfile
  workspaceLease: ConversationWorkspaceLease | null
}

export interface ChatAccessInput {
  workspacePath: string
  /** Conversation-turn id used as workspace lease ownerId. */
  turnId: string
  coreCode: string
}

export interface CreateTaskAccessInput {
  workspacePath: string
  coreCode: string
}
