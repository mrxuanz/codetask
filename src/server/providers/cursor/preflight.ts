import { spawnProviderCommandSync } from '../spawn'
import { ProviderAuthError } from '../../sandbox/provider-auth/errors'
import type { ProviderAuthPrepared } from '../../sandbox/provider-auth/types'
import type { ProviderInstallation } from '../../../shared/providers/installation'

const PREFLIGHT_TIMEOUT_MS = 15_000
const CURSOR_LABEL = 'Cursor CLI'
const CURSOR_LOGIN_HINT = 'Run `agent login` in a terminal and retry.'

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

function isLoggedInFromText(text: string): boolean {
  const lower = text.toLowerCase()
  if (/\blogged\s*in\b/.test(lower) && !/\bnot\s+logged\s+in\b/.test(lower)) return true
  if (/"loggedin"\s*:\s*true/.test(lower)) return true
  if (/"logged_in"\s*:\s*true/.test(lower)) return true
  if (/\bauthenticated\b/.test(lower) && !/\bnot\s+authenticated\b/.test(lower)) return true
  if (/\boauth_token\b/.test(lower)) return true
  return false
}

/**
 * Cursor auth preflight owned by the Cursor driver module.
 * Host-identity semantics: env key / host snapshot / `agent status` probe.
 * Probe-only: never logs in, never writes host credential files.
 */
export function runCursorAuthPreflight(
  prepared: ProviderAuthPrepared,
  installation: ProviderInstallation
): void {
  const probe = runProbe(installation, ['status'], prepared.envPatch)
  const combined = `${probe.stdout}\n${probe.stderr}`
  if (probe.ok && isLoggedInFromText(combined)) return

  if (prepared.diagnostics.authMaterialPresent) return

  throw new ProviderAuthError(
    `${CURSOR_LABEL} is not authenticated. ${CURSOR_LOGIN_HINT}`,
    'cursorcli',
    'provider.cursor.not_authenticated'
  )
}
