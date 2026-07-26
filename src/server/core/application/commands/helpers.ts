import { IdempotencyConflictError, assertIdempotency } from '../idempotency'
import type { IdempotencyStore } from '../idempotency'
import { RevisionConflictError } from '../ports/repositories'
import { fail, ok, type CommandResult } from '../results'
import type { UnitOfWork } from '../ports/unit-of-work'
import type { ApplicationEvent } from '../ports/event-publisher'

export type CommandBase = {
  readonly idempotencyKey: string
  readonly payloadHash: string
  readonly actorId?: string
}

export function mapThrownToResult<T>(error: unknown): CommandResult<T> {
  if (error instanceof IdempotencyConflictError) {
    return fail(error.code, error.message)
  }
  if (error instanceof RevisionConflictError) {
    return fail(error.code, error.message)
  }
  if (
    error instanceof Error &&
    'code' in error &&
    typeof (error as { code: unknown }).code === 'string'
  ) {
    return fail((error as { code: string }).code, error.message)
  }
  throw error
}

export async function withIdempotency<T>(
  store: IdempotencyStore,
  command: CommandBase,
  execute: () => Promise<CommandResult<T>>
): Promise<CommandResult<T>> {
  const existing = await store.get(command.idempotencyKey)
  if (existing) {
    try {
      assertIdempotency(existing.payloadHash, command.payloadHash, command.idempotencyKey)
      return ok(JSON.parse(existing.resultJson) as T)
    } catch (error: unknown) {
      return mapThrownToResult(error)
    }
  }

  const result = await execute()
  if (result.ok) {
    await store.put(command.idempotencyKey, {
      payloadHash: command.payloadHash,
      resultJson: JSON.stringify(result.value)
    })
  }
  return result
}

export async function runInUow<T>(
  uow: UnitOfWork,
  fn: (uow: UnitOfWork) => Promise<CommandResult<T>>,
  event?: ApplicationEvent
): Promise<CommandResult<T>> {
  try {
    return await uow.run(async (tx) => {
      const result = await fn(tx)
      if (result.ok && event) {
        tx.enqueueEvent(event)
      }
      return result
    })
  } catch (error: unknown) {
    return mapThrownToResult(error)
  }
}
