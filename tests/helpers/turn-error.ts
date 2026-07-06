import type { TurnErrorDto } from '../../src/shared/contracts/turn-errors'
import { coerceTurnErrorField } from '../../src/shared/turn-errors/storage.ts'

export function readTurnErrorCode(value: unknown): string | null {
  if (!value) return null
  if (typeof value === 'object' && value && 'code' in value) {
    return String((value as TurnErrorDto).code)
  }
  return coerceTurnErrorField(String(value))?.code ?? null
}

export function readJobLastErrorCode(job: { lastError?: unknown }): string | null {
  return readTurnErrorCode(job.lastError)
}

export function readTaskProgressCode(job: {
  taskProgress?: { progressCode?: string | null }
}): string | null {
  return job.taskProgress?.progressCode ?? null
}

export function readPlanProgressCode(job: {
  planProgress?: { progressCode?: string | null }
}): string | null {
  return job.planProgress?.progressCode ?? null
}
