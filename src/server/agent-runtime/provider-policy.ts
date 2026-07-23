import { roleRequiresOuterSandbox, type ConversationRole } from './roles'
import type { ProviderAuthMode } from '../../shared/providers/capabilities'

export type { ProviderAuthMode }

export interface ProviderRunPolicy {
  outerSandbox: boolean
  innerAccess: 'full-access'
  approvals: 'auto'
  stateRoot: string
  authMode: ProviderAuthMode
}

export function resolveProviderRunPolicy(input: {
  /** Explicit control — must not be inferred from process.env. */
  outerSandbox: boolean
  runtimeRoot: string
}): ProviderRunPolicy {
  return {
    outerSandbox: input.outerSandbox,
    innerAccess: 'full-access',
    approvals: 'auto',
    stateRoot: input.runtimeRoot,
    // Outer sandbox → runtime-copy; direct host turns → host-identity (shared enum).
    authMode: input.outerSandbox ? 'runtime-copy' : 'host-identity'
  }
}

export function resolveProviderOuterSandbox(
  role: ConversationRole,
  optionsOuterSandbox?: boolean
): boolean {
  if (roleRequiresOuterSandbox(role)) {
    if (optionsOuterSandbox === false) {
      throw new Error(`${role} cannot disable outer sandbox`)
    }
    return true
  }
  if (optionsOuterSandbox === true) return true
  return false
}
