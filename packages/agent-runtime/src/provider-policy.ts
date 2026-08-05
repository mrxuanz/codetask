import { roleRequiresOuterSandbox, type ConversationRole } from './roles.ts'

/** Mirrors provider-runtime-node/spec without creating a package cycle. */
export type ProviderAuthMode = 'host-identity'

export interface ProviderRunPolicy {
  outerSandbox: boolean
  innerAccess: 'full-access'
  approvals: 'auto'
  authMode: ProviderAuthMode
}

export function resolveProviderRunPolicy(input: {
  /** Explicit control — must not be inferred from process.env / Electron shell. */
  outerSandbox: boolean
}): ProviderRunPolicy {
  return {
    outerSandbox: input.outerSandbox,
    innerAccess: 'full-access',
    approvals: 'auto',
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
