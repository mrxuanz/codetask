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
    // Authentication always uses native host identity paths. The outer sandbox
    // decides which exact Provider paths are visible; it never copies them.
    authMode: 'host-identity'
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
