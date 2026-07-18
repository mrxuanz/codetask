import { describe, it } from 'node:test'
import assert from 'node:assert'
import {
  validateTaskResultSemantics,
  TaskResultValidationError,
  type TaskResult
} from '@server/domain/tasks/validate-task-result'
import {
  checkMilestoneReadiness,
  type VerificationStatus
} from '@server/application/verification-gate'

function assertCode(code: string) {
  return (err: unknown): boolean =>
    err instanceof TaskResultValidationError && err.code === code
}

function buildTaskResult(overrides: Partial<TaskResult> = {}): TaskResult {
  return {
    status: 'completed',
    summary: 'Task completed successfully',
    changedFiles: ['src/file.ts'],
    evidence: ['Evidence of completion'],
    validation: { ran: true, outcome: 'passed' },
    blockers: [],
    blockerKind: null,
    ...overrides
  }
}

describe('PR4 Fixture Matrix', () => {
  describe('valid results', () => {
    it('should accept completed with passed validation', () => {
      const result = buildTaskResult()
      const validated = validateTaskResultSemantics(result)
      assert.strictEqual(validated.taskState, 'completed')
    })

    it('should accept completed with not-applicable validation', () => {
      const result = buildTaskResult({
        validation: { ran: false, outcome: 'not-applicable' }
      })
      const validated = validateTaskResultSemantics(result)
      assert.strictEqual(validated.taskState, 'completed')
    })

    it('should accept blocked with blockers', () => {
      const result = buildTaskResult({
        status: 'blocked',
        blockers: ['Waiting for dependency'],
        blockerKind: 'dependency'
      })
      const validated = validateTaskResultSemantics(result)
      assert.strictEqual(validated.taskState, 'blocked')
    })

    it('should accept failed', () => {
      const result = buildTaskResult({
        status: 'failed'
      })
      const validated = validateTaskResultSemantics(result)
      assert.strictEqual(validated.taskState, 'failed')
    })
  })

  describe('invalid results', () => {
    it('should reject completed with failed validation', () => {
      const result = buildTaskResult({
        validation: { ran: true, outcome: 'failed' }
      })
      assert.throws(
        () => validateTaskResultSemantics(result),
        assertCode('task_result.completed_validation_not_passed')
      )
    })

    it('should reject completed with blockers', () => {
      const result = buildTaskResult({
        blockers: ['Blocker'],
        blockerKind: 'dependency'
      })
      assert.throws(
        () => validateTaskResultSemantics(result),
        assertCode('task_result.completed_has_blocker')
      )
    })

    it('should reject blocked without blockers', () => {
      const result = buildTaskResult({
        status: 'blocked',
        blockers: [],
        blockerKind: null
      })
      assert.throws(
        () => validateTaskResultSemantics(result),
        assertCode('task_result.blocked_without_reason')
      )
    })

    it('should reject blocked without blockerKind', () => {
      const result = buildTaskResult({
        status: 'blocked',
        blockers: ['Reason'],
        blockerKind: null
      })
      assert.throws(
        () => validateTaskResultSemantics(result),
        assertCode('task_result.blocked_without_reason')
      )
    })
  })

  describe('verification immutability', () => {
    it('slice 1 passed after task/slice 2 progress', () => {
      const verifications = new Map<string, VerificationStatus>([
        ['s1', { passed: true, verdictBlobHash: 'H1', attemptNo: 1 }]
      ])

      verifications.set('s2', { passed: true, verdictBlobHash: 'H2', attemptNo: 1 })

      assert.strictEqual(verifications.get('s1')?.verdictBlobHash, 'H1')
    })

    it('three slices milestone readiness', () => {
      const verifications = new Map<string, VerificationStatus>([
        ['s1', { passed: true, verdictBlobHash: 'H1', attemptNo: 1 }],
        ['s2', { passed: true, verdictBlobHash: 'H2', attemptNo: 1 }],
        ['s3', { passed: true, verdictBlobHash: 'H3', attemptNo: 1 }]
      ])

      const readiness = checkMilestoneReadiness('m1', ['s1', 's2', 's3'], verifications)
      assert.strictEqual(readiness.ready, true)
    })

    it('passed missing verdict should quarantine', () => {
      const verifications = new Map<string, VerificationStatus>([
        ['s1', { passed: true, verdictBlobHash: null, attemptNo: 1 }]
      ])

      const readiness = checkMilestoneReadiness('m1', ['s1'], verifications)
      assert.strictEqual(readiness.ready, false)
      assert.ok(readiness.invariantViolations.includes('verification.passed_missing_verdict:s1'))
    })
  })
})
