import { RequestError } from '@agentclientprotocol/sdk'
import type { StopReason } from '@agentclientprotocol/sdk'
import { classifyCursorAcpErrorLite } from './classify-lite'
import { createTurnError, normalizeTurnError, TURN_CANCELLED } from '../../../shared/turn-errors.ts'
import type { TurnErrorDto } from '../../../shared/turn-errors.ts'
import { spawnCursorAgentSync } from './command'

export interface CursorAcpErrorContext {
  phase?: string
  stderr?: string
  exitCode?: number | null
  signal?: string | null
  command?: string
}

function stripAnsi(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/\u001b\[[0-9;]*m/g, '')
}

function extractAboutField(text: string, label: string): string | undefined {
  const pattern = new RegExp(`^${label}\\s*[:：]\\s*(.+)$`, 'im')
  const match = text.match(pattern)
  return match?.[1]?.trim()
}

function parseAboutJson(stdout: string): { userEmail?: string | null; cliVersion?: string } | null {
  const trimmed = stdout.trim()
  if (!trimmed.startsWith('{')) return null
  try {
    const parsed = JSON.parse(trimmed) as { userEmail?: string | null; cliVersion?: string }
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function isUnauthenticatedEmail(email: string): boolean {
  const lower = email.toLowerCase()
  return (
    lower === 'not logged in' ||
    lower.includes('login required') ||
    lower.includes('authentication required')
  )
}

function outputText(value: string | Buffer | null | undefined): string {
  if (typeof value === 'string') return value
  return value?.toString('utf8') ?? ''
}

export function probeCursorAgentAuth(
  command: string,
  env: Record<string, string> = {}
): TurnErrorDto | null {
  const executable = command.trim() || 'agent'
  const result = spawnCursorAgentSync(executable, ['about'], {
    encoding: 'utf8',
    timeout: 15_000,
    stdio: ['ignore', 'pipe', 'pipe'],
    env
  })

  const stdout = outputText(result.stdout)
  const stderr = outputText(result.stderr)

  if (result.error) {
    const err = result.error as NodeJS.ErrnoException
    if (err.code === 'ENOENT') {
      return createTurnError('provider.cursor.cli_missing').toDto()
    }
  }

  if (result.status !== 0) {
    const combined = [stdout, stderr, result.error?.message].filter(Boolean).join('\n')
    const classified = normalizeTurnError(new Error(combined))
    if (classified.code === 'provider.cursor.not_authenticated') {
      return createTurnError('provider.cursor.not_authenticated').toDto()
    }
    const lower = combined.toLowerCase()
    if (
      lower.includes('unknown command') ||
      lower.includes('unrecognized command') ||
      lower.includes('unexpected argument')
    ) {
      return null
    }
    return null
  }

  try {
    const json = parseAboutJson(stdout)
    if (json) {
      if ('userEmail' in json && json.userEmail == null) {
        return createTurnError('provider.cursor.not_authenticated').toDto()
      }
      const email = typeof json.userEmail === 'string' ? json.userEmail.trim() : ''
      if (email && isUnauthenticatedEmail(email)) {
        return createTurnError('provider.cursor.not_authenticated').toDto()
      }
      return null
    }

    const plain = stripAnsi(stdout)
    const userEmail = extractAboutField(plain, 'User Email')
    if (userEmail && isUnauthenticatedEmail(userEmail)) {
      return createTurnError('provider.cursor.not_authenticated').toDto()
    }
    return null
  } catch (error) {
    const combined = [stdout, stderr, error instanceof Error ? error.message : String(error)]
      .filter(Boolean)
      .join('\n')
    const classified = normalizeTurnError(new Error(combined))
    if (classified.code === 'provider.cursor.not_authenticated') {
      return createTurnError('provider.cursor.not_authenticated').toDto()
    }
    const lower = combined.toLowerCase()
    if (
      lower.includes('unknown command') ||
      lower.includes('unrecognized command') ||
      lower.includes('unexpected argument')
    ) {
      return null
    }
    return null
  }
}

export function isCursorAcpAuthError(error: unknown): boolean {
  return normalizeTurnError(error).code === 'provider.cursor.not_authenticated'
}

export function formatCursorStopReason(stopReason: StopReason, hasReply: boolean): string | null {
  switch (stopReason) {
    case 'end_turn':
      return null
    case 'cancelled':
      return hasReply
        ? TURN_CANCELLED.message
        : createTurnError('turn.cancelled', { detail: 'Cursor ACP turn cancelled' }).message
    case 'refusal':
      return createTurnError('provider.cursor.acp_failed', {
        detail: 'Cursor Agent refused this request'
      }).message
    case 'max_tokens':
      return createTurnError('turn.context_overflow', {
        detail: hasReply
          ? 'Cursor Agent reply truncated by token limit'
          : 'Cursor Agent produced no reply due to token limit'
      }).message
    case 'max_turn_requests':
      return createTurnError('provider.cursor.acp_failed', {
        detail: 'Cursor Agent reached the turn/tool request limit'
      }).message
    default:
      return createTurnError('provider.cursor.acp_failed', {
        detail: `Cursor ACP ended abnormally (${stopReason})`
      }).message
  }
}

export function classifyCursorAcpError(
  error: unknown,
  context: CursorAcpErrorContext = {}
): TurnErrorDto {
  if (error instanceof RequestError && error.code === -32002) {
    return createTurnError('provider.cursor.acp_failed', {
      detail: 'Cursor ACP resource not found; retry or start a new conversation'
    }).toDto()
  }

  if (context.exitCode !== undefined && context.exitCode !== null && context.exitCode !== 0) {
    const stderr = context.stderr?.trim()
    return createTurnError('provider.cursor.acp_failed', {
      detail: `Cursor Agent process exited with code ${context.exitCode}${stderr ? `\n${stderr.slice(-600)}` : ''}`
    }).toDto()
  }

  const base = normalizeTurnError(error)
  if (context.phase && base.code.startsWith('provider.cursor.')) {
    return createTurnError(base.code, {
      params: base.params,
      detail: `${context.phase}: ${base.detail ?? base.message}`
    }).toDto()
  }

  if (context.phase && base.code === 'turn.unknown') {
    return createTurnError('provider.cursor.acp_failed', {
      detail: `${context.phase}: ${base.message}`
    }).toDto()
  }

  if (base.code !== 'turn.unknown') {
    return base
  }

  const lite = classifyCursorAcpErrorLite(error)
  return createTurnError('provider.cursor.acp_failed', { detail: lite }).toDto()
}
