import { isTurnErrorCode, TURN_ERROR_DEFAULT_MESSAGES, type TurnErrorCode } from './codes.ts'
import type { TurnErrorDto } from './types.ts'
import {
  createTurnError,
  formatTurnErrorMessage,
  isTurnError,
  type TurnError
} from './turn-error.ts'

function readErrorName(error: unknown): string | undefined {
  return error instanceof Error ? error.name : undefined
}

function readErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message.trim()
  return String(error ?? '').trim()
}

function readSandboxErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined
  if ((error as { name?: string }).name !== 'SandboxError') return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

function readAcpRequestErrorCode(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined
  if ((error as { name?: string }).name !== 'RequestError') return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'number' ? code : undefined
}

function isUserTurnCancellation(error: unknown): boolean {
  if (readErrorName(error) === 'AbortError') return true

  const sandboxCode = readSandboxErrorCode(error)
  if (sandboxCode === 'sandbox.turn.cancelled') return true

  if (readAcpRequestErrorCode(error) === -32800) return true

  if (isTurnError(error)) {
    const code = (error as TurnError).code
    return code === 'turn.cancelled' || code === 'job.paused' || code === 'job.cancelled'
  }

  return false
}

function matchExactDefaultMessage(message: string): TurnErrorCode | undefined {
  for (const [code, defaultMessage] of Object.entries(TURN_ERROR_DEFAULT_MESSAGES) as Array<
    [TurnErrorCode, string]
  >) {
    if (defaultMessage === message) return code
  }
  return undefined
}

function indicatesCursorAcpKeepaliveTimeout(message: string): boolean {
  const lower = message.toLowerCase()
  return (
    lower.includes('keepalive') ||
    lower.includes('http/2') ||
    lower.includes('stream ended without turnended') ||
    lower.includes('retriableerror') ||
    lower.includes('connecterror')
  )
}

const SANDBOX_CODE_MAP: Record<string, TurnErrorCode> = {
  'sandbox.turn.cancelled': 'sandbox.turn.cancelled',
  'sandbox.turn.timed_out': 'sandbox.turn.timed_out',
  'sandbox.child_closed': 'sandbox.child_closed',
  'sandbox.worker.busy': 'sandbox.worker.busy',
  'sandbox.worker.missing': 'sandbox.worker.missing',
  'sandbox.required': 'sandbox.required',
  'sandbox.supervisor.cleanup_failed': 'sandbox.supervisor.cleanup_failed',
  'sandbox.supervisor.crashed': 'sandbox.supervisor.crashed',
  'provider.auth.missing': 'provider.auth.missing',
  'provider.claude.not_authenticated': 'provider.claude.not_authenticated',
  'provider.codex.not_authenticated': 'provider.codex.not_authenticated',
  'provider.codex.config_invalid': 'provider.codex.config_invalid',
  'provider.cursor.not_authenticated': 'provider.cursor.not_authenticated',
  'provider.opencode.not_authenticated': 'provider.opencode.not_authenticated'
}

export function normalizeTurnError(error: unknown): TurnErrorDto {
  if (isTurnError(error)) {
    return error.toDto()
  }

  if (isUserTurnCancellation(error)) {
    if (isTurnError(error)) {
      return error.toDto()
    }
    const sandboxCode = readSandboxErrorCode(error)
    if (sandboxCode === 'sandbox.turn.cancelled') {
      return createTurnError('sandbox.turn.cancelled').toDto()
    }
    return createTurnError('turn.cancelled').toDto()
  }

  const sandboxCode = readSandboxErrorCode(error)
  if (sandboxCode) {
    const mapped = SANDBOX_CODE_MAP[sandboxCode]
    if (mapped) {
      return createTurnError(mapped, { detail: readErrorMessage(error) }).toDto()
    }
    // Worker/supervisor may preserve the original TurnErrorCode on SandboxError.
    if (isTurnErrorCode(sandboxCode)) {
      return createTurnError(sandboxCode, {
        message: readErrorMessage(error) || undefined
      }).toDto()
    }
    if (sandboxCode === 'sandbox.sdk.error' || sandboxCode === 'sandbox.worker.exit') {
      return normalizeTurnError(new Error(readErrorMessage(error)))
    }
  }

  const raw = readErrorMessage(error)
  if (indicatesCursorAcpKeepaliveTimeout(raw)) {
    return createTurnError('provider.cursor.acp_keepalive_timeout', { detail: raw }).toDto()
  }

  const message =
    raw.replace(/^\[role-worker\]\s*/i, '').trim() || formatTurnErrorMessage('turn.unknown')

  const matched = matchExactDefaultMessage(message)
  if (matched) {
    return createTurnError(matched, { detail: raw || undefined }).toDto()
  }

  return {
    code: 'turn.unknown',
    message,
    detail: raw || null
  }
}

export function normalizeTurnErrorFromMessage(message: string): TurnErrorDto {
  return normalizeTurnError(new Error(message))
}

export function turnErrorFromUnknown(error: unknown): TurnErrorDto {
  return normalizeTurnError(error)
}

export { isUserTurnCancellation }
