import type { TurnErrorCode, TurnErrorParams } from './codes.ts'
import { TURN_ERROR_SCHEMA_VERSION } from './codes.ts'

export interface TurnErrorDto {
  code: TurnErrorCode
  message: string
  params?: TurnErrorParams
  detail?: string | null
}

export interface StoredTurnErrorPayload {
  v: typeof TURN_ERROR_SCHEMA_VERSION
  code: TurnErrorCode
  message: string
  params?: TurnErrorParams
  detail?: string | null
}

export function toTurnErrorDto(payload: StoredTurnErrorPayload): TurnErrorDto {
  return {
    code: payload.code,
    message: payload.message,
    params: payload.params,
    detail: payload.detail ?? null
  }
}

export function fromTurnErrorDto(dto: TurnErrorDto): StoredTurnErrorPayload {
  return {
    v: TURN_ERROR_SCHEMA_VERSION,
    code: dto.code,
    message: dto.message,
    params: dto.params,
    detail: dto.detail ?? null
  }
}
