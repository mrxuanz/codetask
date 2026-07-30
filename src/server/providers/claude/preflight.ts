import { ProviderAuthError } from '../../sandbox/provider-auth/errors'
import type { ProviderRuntimeProfile } from '../../sandbox/provider-auth/types'
import type { ProviderInstallation } from '../../../shared/providers/installation'

const CLAUDE_LABEL = 'Claude Code'
const CLAUDE_LOGIN_HINT = 'Run `claude auth login` in a terminal and retry.'

/**
 * Claude auth preflight owned by the Claude driver module.
 *
 * Outer-sandbox turns use settingSources=[] and an exact host-identity allowlist,
 * so prepared auth diagnostics describe the material available to the SDK runtime.
 * Probing an independently installed host CLI would validate the wrong binary
 * and can fail inside an isolated HOME when that CLI is a toolchain shim.
 */
export function runClaudeAuthPreflight(
  profile: ProviderRuntimeProfile,
  _installation: ProviderInstallation
): void {
  if (profile.diagnostics.authMaterialPresent) return

  throw new ProviderAuthError(
    `${CLAUDE_LABEL} is not authenticated. ${CLAUDE_LOGIN_HINT}`,
    'claude-code',
    'provider.claude.not_authenticated'
  )
}
