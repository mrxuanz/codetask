import { spawnProviderCommandSync } from '../spawn'
import { ProviderAuthError } from '../../sandbox/provider-auth/errors'
import type { ProviderAuthPrepared } from '../../sandbox/provider-auth/types'
import type { ProviderInstallation } from '../../../shared/providers/installation'

const PREFLIGHT_TIMEOUT_MS = 15_000
const CLAUDE_LABEL = 'Claude Code'
const CLAUDE_LOGIN_HINT = 'Run `claude auth login` in a terminal and retry.'

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

/**
 * Claude auth preflight owned by the Claude driver module.
 * Probe-only: never logs in, never creates accounts, never writes host credential files.
 */
export function runClaudeAuthPreflight(
  prepared: ProviderAuthPrepared,
  installation: ProviderInstallation
): void {
  const probe = runProbe(installation, ['auth', 'status'], prepared.envPatch)
  const combined = `${probe.stdout}\n${probe.stderr}`
  if (probe.ok && isLoggedInFromText(combined)) return

  const json = parseJsonProbe(combined)
  if (json && (json.loggedIn === true || json.logged_in === true)) return

  throw new ProviderAuthError(
    `${CLAUDE_LABEL} is not authenticated. ${CLAUDE_LOGIN_HINT}`,
    'claude-code',
    'provider.claude.not_authenticated'
  )
}
