export const PROVIDER_CAPABILITY_PROFILES = [
  'chat-write',
  'chat-read',
  'planner-read',
  'task-sandbox',
  'verifier-sandbox'
] as const

export type ProviderCapabilityProfile = (typeof PROVIDER_CAPABILITY_PROFILES)[number]

export type ProviderProtocol = 'sdk' | 'acp' | 'local-server'
export type ProviderAuthMode = 'host-identity'
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

export type ProviderConversationScopeKind = 'chat'

export function buildConversationProviderRuntimeScopeId(
  conversationId: string,
  _kind: ProviderConversationScopeKind = 'chat'
): string {
  return `conversation:${conversationId}`
}

export interface ProviderCapabilities {
  readonly authMode: ProviderAuthMode
  readonly protocol: ProviderProtocol
  readonly supportedProfiles: readonly ProviderCapabilityProfile[]
  readonly reuse: readonly ProviderReusePolicy[]
  /** Current product decision: CodeTask has no user-selectable isolated account home. */
  readonly supportsIsolatedHome: false
}
