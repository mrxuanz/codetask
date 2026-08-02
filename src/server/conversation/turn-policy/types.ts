import type { WorkspaceAccessMode } from '../../../shared/workspace-access.ts'
import type { AgentCapabilityProfile } from '../../agent-runtime/capabilities'
import type { WorkspaceLeaseOwnerKind } from '../../infra/workspace-lease-store'

/** Lease held by an ordinary chat turn while it has exclusive write access. */
export interface ConversationWorkspaceLease {
  leaseId: string
  ownerKind: Extract<WorkspaceLeaseOwnerKind, 'conversation' | 'conversation-turn'>
  ownerId: string
}

/**
 * Workspace + capability decision for one conversation turn.
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
