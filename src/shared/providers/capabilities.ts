export const PROVIDER_CAPABILITY_PROFILES = [
  'chat-write',
  'chat-read',
  'create-task-read',
  'planner-read',
  'task-sandbox',
  'verifier-sandbox'
] as const

export type ProviderCapabilityProfile = (typeof PROVIDER_CAPABILITY_PROFILES)[number]

export type ProviderProtocol = 'sdk' | 'acp' | 'local-server'
export type ProviderAuthMode = 'runtime-copy' | 'host-identity'
export type ProviderReusePolicy = 'one-shot' | 'conversation-scoped'

/**
 * Runtime scope selected by the central ProviderRuntimeManager.
 * Protocol implementations may use the scope id to pool transport resources,
 * but they must not independently change the reuse policy.
 */
export interface ProviderRuntimeScope {
  readonly id: string
  readonly reusePolicy: ProviderReusePolicy
}

export type ProviderConversationScopeKind = 'chat' | 'create_task'

export function buildConversationProviderRuntimeScopeId(
  threadId: string,
  kind: ProviderConversationScopeKind
): string {
  return `conversation:${kind}:${threadId}`
}

export interface ProviderCapabilities {
  readonly authMode: ProviderAuthMode
  readonly protocol: ProviderProtocol
  readonly supportedProfiles: readonly ProviderCapabilityProfile[]
  readonly reuse: readonly ProviderReusePolicy[]
  /** Current product decision: CodeTask has no user-selectable isolated account home. */
  readonly supportsIsolatedHome: false
}
