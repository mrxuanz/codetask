import { spawnProviderCommandSync } from '../spawn'
import { ProviderAuthError } from '../../sandbox/provider-auth/errors'
import type { ProviderAuthPrepared } from '../../sandbox/provider-auth/types'
import type { ProviderInstallation } from '../../../shared/providers/installation'

const PREFLIGHT_TIMEOUT_MS = 15_000
const OPENCODE_LABEL = 'OpenCode'
const OPENCODE_LOGIN_HINT =
  'Configure OpenCode authentication or set an API key environment variable.'

function runProbe(
  installation: ProviderInstallation,
  args: string[],
  env: Record<string, string>
): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnProviderCommandSync(installation.invocation, args, {
    cwd:
      installation.resolvedPath.includes('/') || installation.resolvedPath.includes('\\')
        ? (env.HOME ?? env.USERPROFILE ?? process.cwd())
        : process.cwd(),
    timeout: PREFLIGHT_TIMEOUT_MS,
    env
  })
  return {
    ok: result.status === 0,
    stdout: (result.stdout ?? '').trim(),
    stderr: (result.stderr ?? '').trim()
  }
}

/**
 * OpenCode auth preflight owned by the OpenCode driver module.
 * Probe-only: never logs in, never creates accounts, never writes host credential files.
 */
export function runOpenCodeAuthPreflight(
  prepared: ProviderAuthPrepared,
  installation: ProviderInstallation
): void {
  if (prepared.diagnostics.authMaterialPresent) return

  const probe = runProbe(installation, ['auth', 'list'], prepared.envPatch)
  const combined = `${probe.stdout}\n${probe.stderr}`
  if (probe.ok && /\bcredentials?\b/i.test(combined) && !/\b0\s+credentials?\b/i.test(combined)) {
    return
  }

  throw new ProviderAuthError(
    `${OPENCODE_LABEL} is not authenticated. ${OPENCODE_LOGIN_HINT}`,
    'opencode',
    'provider.opencode.not_authenticated'
  )
}
