import { spawnSync } from 'child_process'
import type { SupportedCoreCode } from '../../conversation/cores'
import { sandboxTurnDebug } from '../../debug/sandbox-turn'
import { SandboxError } from '../types'
import { snapshotCodexHostAuth, snapshotCursorHostAuth, snapshotOpencodeHostAuth } from './paths'
import type { ProviderAuthPrepared } from './types'

const PREFLIGHT_TIMEOUT_MS = 15_000

export class ProviderAuthError extends SandboxError {
  constructor(
    message: string,
    readonly provider: SupportedCoreCode,
    override readonly code: string = 'provider.auth.missing',
    readonly userAction?: string
  ) {
    super(message, code, provider)
    this.name = 'ProviderAuthError'
  }
}

const PROVIDER_LABELS: Record<SupportedCoreCode, string> = {
  codex: 'Codex',
  'claude-code': 'Claude Code',
  cursorcli: 'Cursor CLI',
  opencode: 'OpenCode'
}

const LOGIN_HINTS: Record<SupportedCoreCode, string> = {
  codex: 'Run `codex login` in a terminal and retry.',
  'claude-code': 'Run `claude auth login` in a terminal and retry.',
  cursorcli: 'Run `agent login` in a terminal and retry.',
  opencode: 'Configure OpenCode authentication or set an API key environment variable.'
}

function runProbe(
  command: string,
  args: string[],
  env: Record<string, string>
): { ok: boolean; stdout: string; stderr: string; code: number | null } {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: PREFLIGHT_TIMEOUT_MS,
    env: { ...process.env, ...env },
    windowsHide: true,
    shell: process.platform === 'win32'
  })

  return {
    ok: result.status === 0,
    stdout: (result.stdout ?? '').trim(),
    stderr: (result.stderr ?? '').trim(),
    code: result.status
  }
}

function resolveCommand(candidates: string[]): string | null {
  for (const command of candidates) {
    try {
      if (process.platform === 'win32') {
        const result = spawnSync('where', [command], {
          encoding: 'utf8',
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'ignore']
        })
        const line = (result.stdout ?? '').split(/\r?\n/)[0]?.trim()
        if (line) return command
      } else {
        const result = spawnSync('which', [command], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore']
        })
        if ((result.stdout ?? '').trim()) return command
      }
    } catch {
      // ignore
    }
  }
  return null
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

function probeCodex(prepared: ProviderAuthPrepared): void {
  const hostAuth = snapshotCodexHostAuth()
  const hasEnvKey = Boolean(process.env.OPENAI_API_KEY?.trim() || process.env.CODEX_API_KEY?.trim())
  if (!prepared.diagnostics.authMaterialPresent && !hostAuth.present && !hasEnvKey) {
    throw new ProviderAuthError(
      `${PROVIDER_LABELS.codex} is not authenticated. ${LOGIN_HINTS.codex}`,
      'codex',
      'provider.codex.not_authenticated'
    )
  }

  const command = resolveCommand(['codex'])
  if (!command) return

  const probe = runProbe(command, ['login', 'status'], prepared.envPatch)
  const combined = `${probe.stdout}\n${probe.stderr}`
  if (probe.ok && isLoggedInFromText(combined)) {
    probeCodexConfig(command, prepared)
    return
  }

  const json = parseJsonProbe(combined)
  if (json && (json.loggedIn === true || json.logged_in === true)) {
    probeCodexConfig(command, prepared)
    return
  }

  if (prepared.diagnostics.authMaterialPresent || hostAuth.present || hasEnvKey) {
    probeCodexConfig(command, prepared)
    return
  }

  throw new ProviderAuthError(
    `${PROVIDER_LABELS.codex} auth snapshot is invalid. ${LOGIN_HINTS.codex}`,
    'codex',
    'provider.codex.not_authenticated'
  )
}

function probeCodexConfig(command: string, prepared: ProviderAuthPrepared): void {
  const probe = runProbe(command, ['mcp', 'list'], prepared.envPatch)
  const combined = `${probe.stdout}\n${probe.stderr}`
  if (/failed to load configuration/i.test(combined)) {
    throw new ProviderAuthError(
      `${PROVIDER_LABELS.codex} runtime config.toml is invalid; check custom model provider settings. ${LOGIN_HINTS.codex}`,
      'codex',
      'provider.codex.config_invalid'
    )
  }
}

function probeClaude(prepared: ProviderAuthPrepared): void {
  const command = resolveCommand(['claude', 'claude-code'])
  if (!command) return

  const probe = runProbe(command, ['auth', 'status'], prepared.envPatch)
  const combined = `${probe.stdout}\n${probe.stderr}`
  if (probe.ok && isLoggedInFromText(combined)) return

  const json = parseJsonProbe(combined)
  if (json && (json.loggedIn === true || json.logged_in === true)) return

  throw new ProviderAuthError(
    `${PROVIDER_LABELS['claude-code']} is not authenticated. ${LOGIN_HINTS['claude-code']}`,
    'claude-code',
    'provider.claude.not_authenticated'
  )
}

function probeCursor(prepared: ProviderAuthPrepared): void {
  const hostAuth = snapshotCursorHostAuth()
  const hasEnvKey = Boolean(process.env.CURSOR_API_KEY?.trim())

  const command = resolveCommand(['agent', 'cursor-agent'])
  if (command) {
    const probe = runProbe(command, ['status'], prepared.envPatch)
    const combined = `${probe.stdout}\n${probe.stderr}`
    if (probe.ok && isLoggedInFromText(combined)) return
  }

  if (prepared.diagnostics.authMaterialPresent || hostAuth.present || hasEnvKey) return

  throw new ProviderAuthError(
    `${PROVIDER_LABELS.cursorcli} is not authenticated. ${LOGIN_HINTS.cursorcli}`,
    'cursorcli',
    'provider.cursor.not_authenticated'
  )
}

function probeOpencode(prepared: ProviderAuthPrepared): void {
  const hasEnvKey = Boolean(
    process.env.ANTHROPIC_API_KEY?.trim() ||
    process.env.OPENAI_API_KEY?.trim() ||
    process.env.OPENCODE_API_KEY?.trim()
  )
  if (prepared.diagnostics.authMaterialPresent || hasEnvKey) return

  const hostAuth = snapshotOpencodeHostAuth()
  if (hostAuth.present) return

  const command = resolveCommand(['opencode'])
  if (command) {
    const probe = runProbe(command, ['auth', 'list'], prepared.envPatch)
    const combined = `${probe.stdout}\n${probe.stderr}`
    if (probe.ok && /\bcredentials?\b/i.test(combined) && !/\b0\s+credentials?\b/i.test(combined)) {
      return
    }
  }

  throw new ProviderAuthError(
    `${PROVIDER_LABELS.opencode} is not authenticated. ${LOGIN_HINTS.opencode}`,
    'opencode',
    'provider.opencode.not_authenticated'
  )
}

export function runProviderAuthPreflight(
  provider: SupportedCoreCode,
  prepared: ProviderAuthPrepared
): void {
  if (process.env.CODETASK_SKIP_PROVIDER_AUTH_PREFLIGHT === '1') {
    sandboxTurnDebug('preflight: skipped', { provider })
    return
  }

  const started = Date.now()
  sandboxTurnDebug('preflight: begin', { provider })

  switch (provider) {
    case 'codex':
      probeCodex(prepared)
      break
    case 'claude-code':
      probeClaude(prepared)
      break
    case 'cursorcli':
      probeCursor(prepared)
      break
    case 'opencode':
      probeOpencode(prepared)
      break
    default:
      break
  }

  sandboxTurnDebug('preflight: done', { provider, elapsedMs: Date.now() - started })
}

export function providerAuthFailureMessage(error: unknown): string | null {
  if (error instanceof ProviderAuthError) return error.message
  if (error instanceof SandboxError && error.code === 'provider.auth.missing') {
    return error.message
  }
  return null
}
