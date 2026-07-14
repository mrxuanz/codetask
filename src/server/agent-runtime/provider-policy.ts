import { roleRequiresOuterSandbox, type ConversationRole } from './roles'
import { appendCursorApiEndpointArgs } from './cursor-acp/config'

export type ProviderAuthMode = 'runtime-copy' | 'env-token' | 'host-identity-dev-only'

export interface ProviderRunPolicy {
  outerSandbox: boolean
  innerAccess: 'full-access'
  approvals: 'auto'
  stateRoot: string
  authMode: ProviderAuthMode
}

export function resolveProviderRunPolicy(input: {
  outerSandbox?: boolean
  runtimeRoot: string
}): ProviderRunPolicy {
  const outerSandbox = input.outerSandbox ?? process.env.CODETASK_OUTER_SANDBOX === '1'
  return {
    outerSandbox,
    innerAccess: 'full-access',
    approvals: 'auto',
    stateRoot: input.runtimeRoot,
    authMode: outerSandbox ? 'runtime-copy' : 'host-identity-dev-only'
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

export function buildCursorAcpCliArgs(input: { outerSandbox: boolean; cwd?: string }): string[] {
  if (!input.outerSandbox) {
    const args: string[] = []
    if (process.env.CODETASK_CURSOR_APPROVE_MCPS !== '0') {
      args.push('--approve-mcps')
    }
    return appendCursorApiEndpointArgs([...args, 'acp'])
  }

  const args = ['--trust', '--force', '--sandbox', 'disabled', '--approve-mcps']
  const cwd = input.cwd?.trim()
  if (cwd) {
    args.push('--workspace', cwd)
  }
  return appendCursorApiEndpointArgs([...args, 'acp'])
}
