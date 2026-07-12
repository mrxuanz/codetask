import { isTurnErrorCode, type TurnErrorCode } from './codes.ts'
import type { TurnErrorDto } from './types.ts'
import { isTurnError } from './turn-error.ts'
import { isUserTurnCancellation, normalizeTurnError } from './normalize.ts'

const GENERIC_SANDBOX_WRAPPER_CODES = new Set<string>([
  'sandbox.sdk.error',
  'sandbox.worker.exit'
])

const SANDBOX_NATIVE_NON_RETRY = new Set<string>([
  'sandbox.turn.cancelled',
  'sandbox.required',
  'provider.auth.missing',
  'sandbox.worker.busy',
  'sandbox.worker.missing',
  'sandbox.path.empty',
  'sandbox.path.relative',
  'sandbox.path.missing',
  'sandbox.disabled',
  'sandbox.supervisor.shutdown'
])

const SANDBOX_NATIVE_RETRY = new Set<string>([
  'sandbox.supervisor.crashed',
  'sandbox.supervisor.disconnected',
  'sandbox.supervisor.cleanup_failed',
  'sandbox.turn.timed_out',
  'sandbox.sdk.error',
  'sandbox.worker.exit',
  'sandbox.child_closed'
])

const NON_RETRYABLE_TURN_CODES = new Set<TurnErrorCode>([
  'turn.cancelled',
  'job.paused',
  'job.cancelled',
  'sandbox.turn.cancelled',
  'sandbox.required',
  'sandbox.worker.busy',
  'sandbox.worker.missing',
  'provider.auth.missing',
  'provider.cursor.not_authenticated',
  'provider.cursor.cli_missing',
  'provider.cursor.auth_unknown',
  'provider.codex.config_invalid',
  'provider.cli_auth_failed',
  'provider.opencode.cli_missing',
  // Mid-turn OpenCode session_error is deterministic for the same prompt/command;
  // infra-retry only burns 5min×N. Real hangs should surface as turn.timed_out via watchdog.
  'provider.opencode.session_error',
  'task.infra_retry_exhausted',
  'task.terminal_failure',
  'workflow.deadlock',
  'workflow.failed_block',
  'plan.cancelled',
  'plan.sandbox_cleanup_failed',
  'turn.context_overflow',
  'auth.unauthorized',
  'auth.session_expired'
])

const RETRYABLE_TURN_CODES = new Set<TurnErrorCode>([
  'sandbox.child_closed',
  'sandbox.turn.timed_out',
  'sandbox.supervisor.cleanup_failed',
  'sandbox.supervisor.crashed',
  'provider.codex.stream_disconnected',
  'provider.codex.api_unreachable',
  'provider.rate_limited',
  'provider.cursor.acp_failed',
  'provider.cursor.acp_authenticate_failed',
  'provider.cursor.acp_initialize_failed',
  'provider.cursor.acp_keepalive_timeout',
  'provider.cursor.acp_empty_turn',
  'provider.cursor.acp_stdio_unavailable',
  'provider.opencode.server_timeout',
  'provider.opencode.server_exited',
  'provider.opencode.stream_disconnected',
  'turn.timed_out',
  'turn.empty_reply',
  'turn.incomplete',
  'turn.capacity_limited',
  'turn.watchdog_no_signal',
  'turn.watchdog_idle',
  'turn.watchdog_wall',
  'turn.tool_aborted',
  'task.evidence_timeout',
  'task.verifier_evidence_timeout',
  'plan.sandbox_timeout'
])

const EVIDENCE_MISS_CODES = new Set<TurnErrorCode>([
  'task.evidence_timeout',
  'task.evidence_missing'
])

const VERIFIER_MISS_CODES = new Set<TurnErrorCode>(['task.verifier_evidence_timeout'])

function readSandboxNativeCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined
  if ((error as { name?: string }).name !== 'SandboxError') return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

function isSandboxError(error: unknown): boolean {
  return readSandboxNativeCode(error) !== undefined
}

export function resolveTurnErrorDto(error: unknown): TurnErrorDto {
  if (isTurnError(error)) return error.toDto()
  return normalizeTurnError(error)
}

export function isRetryableTurnErrorCode(code: TurnErrorCode): boolean {
  if (NON_RETRYABLE_TURN_CODES.has(code)) return false
  return RETRYABLE_TURN_CODES.has(code)
}

export function isInfraTurnErrorCode(code: TurnErrorCode): boolean {
  if (NON_RETRYABLE_TURN_CODES.has(code)) return false
  if (EVIDENCE_MISS_CODES.has(code) || VERIFIER_MISS_CODES.has(code)) return true
  return RETRYABLE_TURN_CODES.has(code)
}

export function isRetryableTurnError(error: unknown): boolean {
  if (isUserTurnCancellation(error)) return false

  const native = readSandboxNativeCode(error)
  if (native) {
    if (SANDBOX_NATIVE_NON_RETRY.has(native)) return false
    // Generic wrappers often hide a provider TurnErrorCode — consult the DTO first.
    if (GENERIC_SANDBOX_WRAPPER_CODES.has(native)) {
      const wrapped = resolveTurnErrorDto(error).code
      if (wrapped !== 'turn.unknown') return isRetryableTurnErrorCode(wrapped)
      return true
    }
    if (SANDBOX_NATIVE_RETRY.has(native)) return true
    if (isTurnErrorCode(native)) return isRetryableTurnErrorCode(native)
  }

  const code = resolveTurnErrorDto(error).code
  return isRetryableTurnErrorCode(code)
}

export function isInfraTurnError(error: unknown): boolean {
  if (isUserTurnCancellation(error)) return false
  const code = resolveTurnErrorDto(error).code
  return isInfraTurnErrorCode(code)
}

export function isTaskEvidenceMissError(error: unknown): boolean {
  return EVIDENCE_MISS_CODES.has(resolveTurnErrorDto(error).code)
}

export function isVerifierEvidenceMissError(error: unknown): boolean {
  return VERIFIER_MISS_CODES.has(resolveTurnErrorDto(error).code)
}

export function isCapacityTurnError(error: unknown): boolean {
  return resolveTurnErrorDto(error).code === 'turn.capacity_limited'
}

export function isTurnInfraFailureMessage(message: string): boolean {
  return isInfraTurnError(new Error(message))
}

export function isTaskEvidenceMissMessage(message: string): boolean {
  return isTaskEvidenceMissError(new Error(message))
}

export function isVerifierToolMissMessage(message: string): boolean {
  return isVerifierEvidenceMissError(new Error(message))
}

export function isNonRetryableSandboxError(error: unknown): boolean {
  const native = readSandboxNativeCode(error)
  return native ? SANDBOX_NATIVE_NON_RETRY.has(native) : false
}

export function isRetryableSandboxError(error: unknown): boolean {
  if (!isSandboxError(error) || isNonRetryableSandboxError(error)) return false
  return isRetryableTurnError(error)
}
