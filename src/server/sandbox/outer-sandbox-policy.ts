export type OuterSandboxPolicyInput = {
  readonly mode: 'desktop' | 'server'
  readonly outerSandboxEnabled: boolean
}

/**
 * Pure outer-sandbox enablement policy (no host env, no AppContext).
 * Server mode always forces the outer sandbox on.
 */
export function resolveOuterSandboxEnabled(input: OuterSandboxPolicyInput): boolean {
  if (input.mode === 'server') {
    return true
  }
  return input.outerSandboxEnabled
}
