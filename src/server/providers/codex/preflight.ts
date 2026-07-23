import { spawnProviderCommandSync } from '../spawn'
import { ProviderAuthError } from '../../sandbox/provider-auth/errors'
import type { ProviderAuthPrepared } from '../../sandbox/provider-auth/types'
import type { ProviderInstallation } from '../../../shared/providers/installation'

const PREFLIGHT_TIMEOUT_MS = 15_000
const CODEX_LABEL = 'Codex'
const CODEX_LOGIN_HINT = 'Run `codex login` in a terminal and retry.'

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

function parseJsonProbe(text: string): Record<string, unknown> | null {
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (!jsonMatch) return null
    try {
      return JSON.parse(jsonMatch[0]) as Record<string, unknown>
    } catch {
      return null
    }
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

function probeCodexConfig(
  installation: ProviderInstallation,
  prepared: ProviderAuthPrepared
): void {
  const probe = runProbe(installation, ['mcp', 'list'], prepared.envPatch)
  const combined = `${probe.stdout}\n${probe.stderr}`
  if (/failed to load configuration/i.test(combined)) {
    throw new ProviderAuthError(
      `${CODEX_LABEL} runtime config.toml is invalid; check custom model provider settings. ${CODEX_LOGIN_HINT}`,
      'codex',
      'provider.codex.config_invalid'
    )
  }
}

/**
 * Codex auth preflight owned by the Codex driver module.
 * Probe-only: never logs in, never creates accounts, never writes host credential files.
 */
export function runCodexAuthPreflight(
  prepared: ProviderAuthPrepared,
  installation: ProviderInstallation
): void {
  if (!prepared.diagnostics.authMaterialPresent) {
    throw new ProviderAuthError(
      `${CODEX_LABEL} is not authenticated. ${CODEX_LOGIN_HINT}`,
      'codex',
      'provider.codex.not_authenticated'
    )
  }

  const probe = runProbe(installation, ['login', 'status'], prepared.envPatch)
  const combined = `${probe.stdout}\n${probe.stderr}`
  if (probe.ok && isLoggedInFromText(combined)) {
    probeCodexConfig(installation, prepared)
    return
  }

  const json = parseJsonProbe(combined)
  if (json && (json.loggedIn === true || json.logged_in === true)) {
    probeCodexConfig(installation, prepared)
    return
  }

  if (prepared.diagnostics.authMaterialPresent) {
    probeCodexConfig(installation, prepared)
    return
  }

  throw new ProviderAuthError(
    `${CODEX_LABEL} auth snapshot is invalid. ${CODEX_LOGIN_HINT}`,
    'codex',
    'provider.codex.not_authenticated'
  )
}
