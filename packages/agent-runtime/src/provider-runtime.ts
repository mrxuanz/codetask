/**
 * Provider reuse policy (Batch F).
 * Kept in a leaf module so index.ts can re-export without circular aliases.
 */
export type AgentRoleForReuse =
  | 'conversation'
  | 'planner'
  | 'task-worker'
  | 'slice-verifier'
  | 'milestone-verifier'

export function resolveReusePolicy(
  role: AgentRoleForReuse,
  capabilityProfile: string
): 'one-shot' | 'conversation-scoped' {
  if (role !== 'conversation' || capabilityProfile === 'chat-write') return 'one-shot'
  return 'conversation-scoped'
}

export function resolveProviderReusePolicy(
  role: AgentRoleForReuse,
  capabilityProfile: string
): 'one-shot' | 'conversation-scoped' {
  return resolveReusePolicy(role, capabilityProfile)
}
