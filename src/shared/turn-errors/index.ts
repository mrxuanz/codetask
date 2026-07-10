import type { TurnErrorCode, TurnErrorParams } from './codes.ts'
import type { TurnErrorDto } from './types.ts'
import { normalizeTurnError } from './normalize.ts'
import { serializeStoredTurnError } from './storage.ts'
import { createTurnError } from './turn-error.ts'

export type { TurnErrorCode, TurnErrorParams } from './codes.ts'
export {
  TURN_ERROR_DEFAULT_MESSAGES,
  TURN_ERROR_SCHEMA_VERSION,
  isTurnErrorCode
} from './codes.ts'

export type { TurnErrorDto, StoredTurnErrorPayload } from './types.ts'
export { fromTurnErrorDto, toTurnErrorDto } from './types.ts'

export {
  TurnError,
  createTurnError,
  formatTurnErrorMessage,
  isTurnError,
  TURN_CANCELLED,
  JOB_PAUSED,
  JOB_CANCELLED
} from './turn-error.ts'

export {
  parseStoredTurnError,
  serializeStoredTurnError,
  coerceTurnErrorField,
  turnErrorDisplayMessage
} from './storage.ts'

export { turnErrorI18nKey, turnErrorsEn, buildTurnErrorI18nTree } from './i18n.ts'
export { turnErrorsZh } from './i18n-zh.ts'
export { turnErrorsJa } from './i18n-ja.ts'

export {
  normalizeTurnError,
  normalizeTurnErrorFromMessage,
  turnErrorFromUnknown,
  isUserTurnCancellation
} from './normalize.ts'

export {
  resolveTurnErrorDto,
  isRetryableTurnError,
  isRetryableTurnErrorCode,
  isInfraTurnError,
  isInfraTurnErrorCode,
  isTaskEvidenceMissError,
  isVerifierEvidenceMissError,
  isCapacityTurnError,
  isTurnInfraFailureMessage,
  isTaskEvidenceMissMessage,
  isVerifierToolMissMessage,
  isNonRetryableSandboxError,
  isRetryableSandboxError
} from './policy.ts'

export function storedTurnErrorFromUnknown(error: unknown): string {
  return serializeStoredTurnError(normalizeTurnError(error))
}

export function storedTurnErrorFromDto(dto: TurnErrorDto): string {
  return serializeStoredTurnError(dto)
}

export function storedTurnErrorFromCode(
  code: TurnErrorCode,
  options?: { params?: TurnErrorParams; detail?: string; message?: string }
): string {
  return serializeStoredTurnError(createTurnError(code, options).toDto())
}
