import { ProviderAuthError } from '../../sandbox/provider-auth/errors'
import type { ProviderAuthPrepared } from '../../sandbox/provider-auth/types'
import type { ProviderInstallation } from '../../../shared/providers/installation'
import { spawnProviderCommandSync } from '../spawn'

const PREFLIGHT_TIMEOUT_MS = 15_000
const CLAUDE_LABEL = 'Claude Code'
const CLAUDE_LOGIN_HINT = 'Run `claude auth login` in a terminal and retry.'

function reportsLoggedIn(output: string): boolean {
  try {
    const parsed = JSON.parse(output) as { loggedIn?: unknown }
    if (parsed.loggedIn === true) return true
  } catch {
    // Older Claude releases may emit plain text.
  }
  const lower = output.toLowerCase()
  return (
    /\blogged\s*in\b/.test(lower) &&
    !/\bnot\s+logged\s+in\b/.test(lower) &&
    !/"loggedin"\s*:\s*false/.test(lower)
  )
}

/**
 * Claude auth preflight owned by the Claude driver module.
 *
 * Probe the exact Driver-selected host CLI identity while disabling filesystem
 * settings. This is read-only and validates the native file/OS-store login
 * without accepting environment-token authority from settings.json.
 */
export function runClaudeAuthPreflight(
  prepared: ProviderAuthPrepared,
  installation: ProviderInstallation
): void {
  const result = spawnProviderCommandSync(
    installation.invocation,
    ['--setting-sources', '', 'auth', 'status', '--json'],
    {
      cwd: process.cwd(),
      env: prepared.envPatch,
      timeout: PREFLIGHT_TIMEOUT_MS
    }
  )
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim()
  if (result.status === 0 && reportsLoggedIn(output)) return

  throw new ProviderAuthError(
    `${CLAUDE_LABEL} is not authenticated. ${CLAUDE_LOGIN_HINT}`,
    'claude-code',
    'provider.claude.not_authenticated'
  )
}
