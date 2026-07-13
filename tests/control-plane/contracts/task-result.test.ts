import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  validateTaskResult,
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

describe('Task Result Validation', () => {
  describe('valid completed', () => {
    it('should accept completed with passed validation', () => {
      const validated = validateTaskResult(buildTaskResult())
      assert.equal(validated.taskState, 'completed')
    })

    it('should accept completed with not-applicable validation via parse path', () => {
      const validated = validateTaskResult({
        ...buildTaskResult(),
        validation: { ran: false, outcome: 'not-applicable' }
      })
      assert.equal(validated.taskState, 'completed')
    })
  })

  describe('invalid completed', () => {
    it('should reject completed with failed validation', () => {
      assert.throws(
        () => validateTaskResultSemantics(buildTaskResult({
          validation: { ran: true, outcome: 'failed' }
        })),
        assertCode('task_result.completed_validation_not_passed')
      )
    })

    it('should reject completed with blockers', () => {
      assert.throws(
        () => validateTaskResultSemantics(buildTaskResult({
          blockers: ['reason'],
          blockerKind: 'dependency'
        })),
        assertCode('task_result.completed_has_blocker')
      )
    })
  })

  describe('valid blocked', () => {
    it('should accept blocked with blockers', () => {
      const validated = validateTaskResultSemantics(buildTaskResult({
        status: 'blocked',
        blockers: ['reason'],
        blockerKind: 'dependency'
      }))
      assert.equal(validated.taskState, 'blocked')
    })
  })

  describe('invalid blocked', () => {
    it('should reject blocked without blockers', () => {
      assert.throws(
        () => validateTaskResultSemantics(buildTaskResult({
          status: 'blocked',
          blockers: [],
          blockerKind: null
        })),
        assertCode('task_result.blocked_without_reason')
      )
    })
  })

  describe('invalid payload', () => {
    it('should reject malformed payload via validateTaskResult', () => {
      assert.throws(
        () => validateTaskResult({ status: 'completed' }),
        assertCode('contract.invalid_payload')
      )
    })
  })
})

describe('Verification', () => {
  describe('slice verification', () => {
    it('should preserve verdict after task progress', () => {
      const verifications = new Map<string, VerificationStatus>([
        ['s1', { passed: true, verdictBlobHash: 'H1', attemptNo: 1 }]
      ])

      const before = verifications.get('s1')
      assert.equal(before?.verdictBlobHash, 'H1')

      // Simulate later task progress without touching slice 1 verification
      verifications.set('s2', { passed: true, verdictBlobHash: 'H2', attemptNo: 1 })

      const after = verifications.get('s1')
      assert.equal(after?.verdictBlobHash, 'H1')
    })

    it('should not create tight-loop on missing verdict', () => {
      const verifications = new Map<string, VerificationStatus>([
        ['s1', { passed: true, verdictBlobHash: null, attemptNo: 1 }]
      ])

      const readiness = checkMilestoneReadiness('m1', ['s1'], verifications)
      assert.equal(readiness.ready, false)
      assert.ok(readiness.invariantViolations.includes('verification.passed_missing_verdict:s1'))
    })
  })

  describe('milestone readiness', () => {
    it('should require all slices passed with verdict', () => {
      const verifications = new Map<string, VerificationStatus>([
        ['s1', { passed: true, verdictBlobHash: 'H1', attemptNo: 1 }],
        ['s2', { passed: true, verdictBlobHash: 'H2', attemptNo: 1 }]
      ])

      const readiness = checkMilestoneReadiness('m1', ['s1', 's2', 's3'], verifications)
      assert.equal(readiness.ready, false)
      assert.deepEqual(readiness.missingVerifications, ['s3'])
    })

    it('should be ready when all slices passed', () => {
      const verifications = new Map<string, VerificationStatus>([
        ['s1', { passed: true, verdictBlobHash: 'H1', attemptNo: 1 }],
        ['s2', { passed: true, verdictBlobHash: 'H2', attemptNo: 1 }],
        ['s3', { passed: true, verdictBlobHash: 'H3', attemptNo: 1 }]
      ])

      const readiness = checkMilestoneReadiness('m1', ['s1', 's2', 's3'], verifications)
      assert.equal(readiness.ready, true)
      assert.equal(readiness.missingVerifications.length, 0)
      assert.equal(readiness.invariantViolations.length, 0)
    })
  })
})
