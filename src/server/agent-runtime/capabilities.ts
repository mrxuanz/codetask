import type { WorkspaceAccessMode } from '../../shared/workspace-access.ts'
import { createTurnError } from '../../shared/turn-errors.ts'
import type { SupportedCoreCode } from '../conversation/cores'
import type { ConversationRole } from './roles'
import {
  getProviderDescriptor,
  type ProviderCapabilityProfile
} from '../../shared/providers'

export type AgentCapabilityProfile = ProviderCapabilityProfile

export const READ_ONLY_CAPABILITY_PROFILES: readonly AgentCapabilityProfile[] = [
  'chat-read',
  'create-task-read',
  'planner-read'
]

export function capabilityProfileIsReadOnly(profile: AgentCapabilityProfile): boolean {
  return READ_ONLY_CAPABILITY_PROFILES.includes(profile)
}

export function capabilityProfileRequiresOuterSandbox(profile: AgentCapabilityProfile): boolean {
  return profile === 'task-sandbox' || profile === 'verifier-sandbox'
}

export function resolveAgentCapabilityProfile(input: {
  role: ConversationRole
  conversationKind?: 'chat' | 'create_task'
  workspaceAccess?: WorkspaceAccessMode
}): AgentCapabilityProfile {
  switch (input.role) {
    case 'task-worker':
      return 'task-sandbox'
    case 'slice-verifier':
    case 'milestone-verifier':
      return 'verifier-sandbox'
    case 'planner':
      return 'planner-read'
    case 'conversation':
      if (input.conversationKind === 'create_task') return 'create-task-read'
      return input.workspaceAccess === 'exclusive-write' ? 'chat-write' : 'chat-read'
  }
}

export function resolveInputCapabilityProfile(input: {
  role: ConversationRole
  capabilityProfile?: AgentCapabilityProfile | undefined
}): AgentCapabilityProfile {
  return (
    input.capabilityProfile ??
    resolveAgentCapabilityProfile({
      role: input.role,
      workspaceAccess: 'live-read'
    })
  )
}

export function assertCapabilityProfileMatchesRole(
  role: ConversationRole,
  profile: AgentCapabilityProfile
): void {
  const valid =
    role === 'conversation'
      ? profile === 'chat-write' ||
        profile === 'chat-read' ||
        profile === 'create-task-read'
      : role === 'planner'
        ? profile === 'planner-read'
        : role === 'task-worker'
          ? profile === 'task-sandbox'
          : profile === 'verifier-sandbox'
  if (valid) return
  throw createTurnError('provider.capability_unsupported', {
    params: { role, profile },
    detail: `Capability profile ${profile} is invalid for role ${role}`
  })
}

export function providerSupportsCapability(
  provider: SupportedCoreCode,
  profile: AgentCapabilityProfile
): boolean {
  // Production drivers mirror descriptor.supportedProfiles via ProviderDriver.supports.
  return getProviderDescriptor(provider).capabilities.supportedProfiles.includes(profile)
}

export function assertProviderSupportsCapability(
  provider: SupportedCoreCode,
  profile: AgentCapabilityProfile
): void {
  if (providerSupportsCapability(provider, profile)) return
  throw createTurnError('provider.capability_unsupported', {
    params: { provider, profile },
    detail: `${provider} cannot reliably disable shell/process execution for ${profile}`
  })
}

export const CLI_READ_ONLY_BUILTINS = ['Read', 'Glob', 'Grep', 'LSP'] as const
