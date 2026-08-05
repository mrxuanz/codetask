import type { WorkspaceAccessMode } from '@codetask/contracts/workspace-access'
import { createTurnError } from '@codetask/contracts/turn-errors'
import type { ConversationRole } from './roles.ts'

export type AgentCapabilityProfile =
  | 'chat-write'
  | 'chat-read'
  | 'planner-read'
  | 'task-sandbox'
  | 'verifier-sandbox'

/** Canonical provider codes used by turn runners (mirrors provider-runtime-node/spec). */
export type SupportedCoreCode = 'codex' | 'claude' | 'opencode' | 'cursor'

export const READ_ONLY_CAPABILITY_PROFILES: readonly AgentCapabilityProfile[] = [
  'chat-read',
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
      ? profile === 'chat-write' || profile === 'chat-read'
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

/**
 * All shipped providers currently advertise the full profile set.
 * Kept as a function so call sites stay stable if a provider later narrows.
 */
export function providerSupportsCapability(
  _provider: SupportedCoreCode,
  _profile: AgentCapabilityProfile
): boolean {
  return true
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
