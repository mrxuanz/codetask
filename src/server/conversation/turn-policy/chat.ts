import { providerSupportsCapability } from '../../agent-runtime/capabilities'
import type { SupportedCoreCode } from '../cores'
import {
  acquireWorkspaceLease,
  releaseWorkspaceLease
} from '../../infra/workspace-lease-store'
import type { ChatAccessInput, ConversationAccessDecision, ConversationWorkspaceLease } from './types'

/**
 * Ordinary chat module access policy.
 *
 * Default: exclusive-write + chat-write when the project directory is free.
 * When a job (or another writer) already holds the directory lease: live-read + chat-read.
 * create-task / job / SDK-ACP sandbox profiles are intentionally out of scope here.
 */
export function resolveChatAccess(input: ChatAccessInput): ConversationAccessDecision {
  const workspacePath = input.workspacePath.trim()
  if (!workspacePath) {
    return {
      workspaceAccess: 'metadata',
      capabilityProfile: 'chat-read',
      workspaceLease: null
    }
  }

  if (!providerSupportsCapability(input.coreCode as SupportedCoreCode, 'chat-read')) {
    throw new Error(`Selected CLI (${input.coreCode}) cannot enforce chat-read`)
  }

  const canWrite = providerSupportsCapability(input.coreCode as SupportedCoreCode, 'chat-write')
  if (!canWrite) {
    return {
      workspaceAccess: 'live-read',
      capabilityProfile: 'chat-read',
      workspaceLease: null
    }
  }

  const acquired = acquireWorkspaceLease({
    workspacePath,
    ownerKind: 'conversation',
    ownerId: input.turnId
  })
  if (!acquired) {
    // Directory occupied (typically by thread_job execution) → chat stays readable only.
    return {
      workspaceAccess: 'live-read',
      capabilityProfile: 'chat-read',
      workspaceLease: null
    }
  }

  return {
    workspaceAccess: 'exclusive-write',
    capabilityProfile: 'chat-write',
    workspaceLease: {
      leaseId: acquired.leaseId,
      ownerKind: 'conversation',
      ownerId: input.turnId
    }
  }
}

export function releaseChatWorkspaceLease(lease: ConversationWorkspaceLease | null): void {
  if (!lease) return
  releaseWorkspaceLease({ leaseId: lease.leaseId })
}
