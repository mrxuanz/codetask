import { Type, type Static } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'

const NonEmptyText = Type.String({ minLength: 1, maxLength: 20_000 })
const ShortCode = Type.String({ minLength: 1, maxLength: 128, pattern: '^[a-z0-9._-]+$' })

export const ValidationResultSchema = Type.Object(
  {
    ran: Type.Boolean(),
    outcome: Type.Union([
      Type.Literal('passed'),
      Type.Literal('failed'),
      Type.Literal('not-applicable'),
      Type.Literal('skipped')
    ]),
    summary: Type.Optional(Type.String({ maxLength: 10_000 }))
  },
  { additionalProperties: false }
)

export type ValidationResult = Static<typeof ValidationResultSchema>

export const TaskResultSchema = Type.Object(
  {
    status: Type.Union([
      Type.Literal('completed'),
      Type.Literal('blocked'),
      Type.Literal('failed')
    ]),
    summary: NonEmptyText,
    changedFiles: Type.Array(Type.String({ minLength: 1, maxLength: 4_096 }), {
      maxItems: 2_000
    }),
    evidence: Type.Array(NonEmptyText, { minItems: 1, maxItems: 200 }),
    validation: ValidationResultSchema,
    blockers: Type.Array(NonEmptyText, { maxItems: 100 }),
    blockerKind: Type.Union([ShortCode, Type.Null()])
  },
  { additionalProperties: false }
)

export type TaskResult = Static<typeof TaskResultSchema>

export type ValidatedTaskResult = {
  readonly taskState: 'completed' | 'blocked' | 'failed'
  readonly result: TaskResult
}

export class TaskResultValidationError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'TaskResultValidationError'
  }
}

export function parseTaskResult(input: unknown): TaskResult {
  if (!Value.Check(TaskResultSchema, input)) {
    throw new TaskResultValidationError('contract.invalid_payload', 'invalid task result payload')
  }
  return input
}

export function validateTaskResultSemantics(result: TaskResult): ValidatedTaskResult {
  if (result.status === 'completed') {
    if (result.blockers.length > 0 || result.blockerKind !== null) {
      throw new TaskResultValidationError(
        'task_result.completed_has_blocker',
        'completed task cannot have blockers'
      )
    }
    if (result.validation.outcome !== 'passed' && result.validation.outcome !== 'not-applicable') {
      throw new TaskResultValidationError(
        'task_result.completed_validation_not_passed',
        'completed task must have passed or not-applicable validation'
      )
    }
    return { taskState: 'completed', result }
  }

  if (result.status === 'blocked') {
    if (result.blockers.length === 0 || result.blockerKind === null) {
      throw new TaskResultValidationError(
        'task_result.blocked_without_reason',
        'blocked task must have blockers and blockerKind'
      )
    }
    return { taskState: 'blocked', result }
  }

  if (result.blockerKind !== null && result.blockers.length === 0) {
    throw new TaskResultValidationError(
      'task_result.failure_blocker_mismatch',
      'failed task with blockerKind must have blockers'
    )
  }
  return { taskState: 'failed', result }
}

export function validateTaskResult(input: unknown): ValidatedTaskResult {
  return validateTaskResultSemantics(parseTaskResult(input))
}
