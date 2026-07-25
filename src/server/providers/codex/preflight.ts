import { ProviderAuthError } from '../../sandbox/provider-auth/errors'
import type { ProviderAuthPrepared } from '../../sandbox/provider-auth/types'
import type { ProviderInstallation } from '../../../shared/providers/installation'

const CODEX_LABEL = 'Codex'
const CODEX_LOGIN_HINT = 'Run `codex login` in a terminal and retry.'

/**
 * Codex auth preflight owned by the Codex driver module.
 *
 * The runtime-copy snapshot is authoritative. Running `login status` on a
 * separately installed CLI validates a different executable than the SDK and
 * makes authentication depend on host toolchain-manager shims.
 */
export function runCodexAuthPreflight(
  prepared: ProviderAuthPrepared,
  _installation: ProviderInstallation
): void {
  if (prepared.diagnostics.authMaterialPresent) return

  throw new ProviderAuthError(
    `${CODEX_LABEL} is not authenticated. ${CODEX_LOGIN_HINT}`,
    'codex',
    'provider.codex.not_authenticated'
  )
}
