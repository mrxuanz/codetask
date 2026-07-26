import type { AgentCapabilityProfile } from '../agent-runtime/capabilities'
import type { ConversationRole } from '../agent-runtime/roles'
import type {
  WorkspaceAccessMode,
  WorkspaceWriteLease
} from '../../shared/workspace-access.ts'
import { SandboxError } from './types'

export interface SandboxWorkspaceAccessRequest {
  readonly role: ConversationRole
  readonly capabilityProfile: AgentCapabilityProfile
  readonly workspaceAccess?: WorkspaceAccessMode | undefined
  readonly workspaceLease?: WorkspaceWriteLease | undefined
  readonly jobId?: string | undefined
}

/**
 * Fail closed before policy compilation. A task role is not authority by
 * itself: the application must also supply the durable lease identity that it
 * acquired for this exact Job.
 */
export function assertSandboxWorkspaceAccess(input: SandboxWorkspaceAccessRequest): void {
  const exclusive = input.workspaceAccess === 'exclusive-write'
  const jobId = input.jobId?.trim() ?? ''
  const leaseId = input.workspaceLease?.leaseId.trim() ?? ''
  const ownerId = input.workspaceLease?.ownerId.trim() ?? ''

  if (input.role === 'task-worker' && !exclusive) {
    throw new SandboxError(
      'task-worker requires an exclusive workspace lease',
      'sandbox.workspace_lease_required',
      'workspace-access'
    )
  }

  if (!exclusive) {
    if (input.workspaceLease) {
      throw new SandboxError(
        'workspace lease supplied without exclusive-write access',
        'sandbox.workspace_lease_unexpected',
        'workspace-access'
      )
    }
    return
  }

  if (input.role !== 'task-worker' || input.capabilityProfile !== 'task-sandbox') {
    throw new SandboxError(
      'exclusive workspace writes are limited to task workers',
      'sandbox.workspace_write_forbidden',
      'workspace-access'
    )
  }

  if (
    !jobId ||
    !leaseId ||
    input.workspaceLease?.ownerKind !== 'job' ||
    ownerId !== jobId
  ) {
    throw new SandboxError(
      'exclusive workspace lease does not match the Job turn',
      'sandbox.workspace_lease_mismatch',
      'workspace-access'
    )
  }
}
