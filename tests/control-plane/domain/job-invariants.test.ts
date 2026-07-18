import { describe, it } from 'node:test'
import assert from 'node:assert'
import type { JobAggregate, JobState } from '@shared/contracts/control-plane'
import {
  validateJobInvariant,
  type ActiveRunSummary
} from '@server/domain/jobs/job-invariants'

function buildJobAggregate(
  overrides: Partial<Pick<JobAggregate, 'state' | 'controlIntent' | 'resumeTarget' | 'activeRunId'>> = {}
): JobAggregate {
  return {
    id: 'job-1',
    threadId: 'thread-1',
    projectId: 'project-1',
    state: 'execution_queued',
    stateRevision: 1,
    controlIntent: 'none',
    resumeTarget: null,
    currentPlanRevision: 1,
    executionGeneration: 1,
    activeRunId: null,
    lastFailureId: null,
    ...overrides
  }
}

function buildActiveRun(
  overrides: Partial<ActiveRunSummary> = {}
): ActiveRunSummary {
  return {
    id: 'run-1',
    state: 'active',
    fenceToken: 'fence-1',
    executionGeneration: 1,
    currentRuntimeInstanceId: 'instance-1',
    ...overrides
  }
}

describe('validateJobInvariant', () => {
  describe('pausing state', () => {
    it('should require pause intent', () => {
      const job = buildJobAggregate({ state: 'pausing', controlIntent: 'none' })
      const run = buildActiveRun()
      const violations = validateJobInvariant(job, run)
      assert.ok(violations.some((v) => v.code === 'job.pausing_without_intent'))
    })

    it('should require resume target', () => {
      const job = buildJobAggregate({ state: 'pausing', controlIntent: 'pause', resumeTarget: null })
      const run = buildActiveRun()
      const violations = validateJobInvariant(job, run)
      assert.ok(violations.some((v) => v.code === 'job.pausing_without_resume_target'))
    })

    it('should require active run', () => {
      const job = buildJobAggregate({
        state: 'pausing',
        controlIntent: 'pause',
        resumeTarget: 'execution_queued',
        activeRunId: null
      })
      const violations = validateJobInvariant(job, null)
      assert.ok(violations.some((v) => v.code === 'job.pausing_without_active_run'))
    })

    it('should pass with valid pausing shape', () => {
      const job = buildJobAggregate({
        state: 'pausing',
        controlIntent: 'pause',
        resumeTarget: 'execution_queued',
        activeRunId: 'run-1'
      })
      const run = buildActiveRun({ id: 'run-1' })
      const violations = validateJobInvariant(job, run)
      assert.strictEqual(violations.length, 0)
    })
  })

  describe('paused state', () => {
    it('should require no control intent', () => {
      const job = buildJobAggregate({
        state: 'paused',
        controlIntent: 'pause',
        resumeTarget: 'execution_queued',
        activeRunId: null
      })
      const violations = validateJobInvariant(job, null)
      assert.ok(violations.some((v) => v.code === 'job.invalid_paused_shape'))
    })

    it('should require no active run', () => {
      const job = buildJobAggregate({
        state: 'paused',
        controlIntent: 'none',
        resumeTarget: 'execution_queued',
        activeRunId: 'run-1'
      })
      const violations = validateJobInvariant(job, null)
      assert.ok(violations.some((v) => v.code === 'job.invalid_paused_shape'))
    })

    it('should require resume target', () => {
      const job = buildJobAggregate({
        state: 'paused',
        controlIntent: 'none',
        resumeTarget: null,
        activeRunId: null
      })
      const violations = validateJobInvariant(job, null)
      assert.ok(violations.some((v) => v.code === 'job.invalid_paused_shape'))
    })

    it('should pass with valid paused shape', () => {
      const job = buildJobAggregate({
        state: 'paused',
        controlIntent: 'none',
        resumeTarget: 'execution_queued',
        activeRunId: null
      })
      const violations = validateJobInvariant(job, null)
      assert.strictEqual(violations.length, 0)
    })
  })

  describe('terminal states', () => {
    const TERMINAL_STATES: JobState[] = ['succeeded', 'failed', 'cancelled']

    for (const state of TERMINAL_STATES) {
      it(`should require no active run in ${state}`, () => {
        const job = buildJobAggregate({ state, activeRunId: 'run-1' })
        const violations = validateJobInvariant(job, null)
        assert.ok(violations.some((v) => v.code === 'job.terminal_has_control_state'))
      })

      it(`should require no control intent in ${state}`, () => {
        const job = buildJobAggregate({ state, controlIntent: 'pause', activeRunId: null })
        const violations = validateJobInvariant(job, null)
        assert.ok(violations.some((v) => v.code === 'job.terminal_has_control_state'))
      })

      it(`should pass with valid ${state} shape`, () => {
        const job = buildJobAggregate({ state, controlIntent: 'none', activeRunId: null })
        const violations = validateJobInvariant(job, null)
        assert.strictEqual(violations.length, 0)
      })
    }
  })

  describe('running states', () => {
    const RUNNING_STATES: JobState[] = ['planning_running', 'execution_running']

    for (const state of RUNNING_STATES) {
      it(`should require active run in ${state}`, () => {
        const job = buildJobAggregate({ state, activeRunId: null })
        const violations = validateJobInvariant(job, null)
        assert.ok(violations.some((v) => v.code === 'job.running_without_active_run'))
      })

      it(`should require matching run in ${state}`, () => {
        const job = buildJobAggregate({ state, activeRunId: 'run-1' })
        const run = buildActiveRun({ id: 'run-2' })
        const violations = validateJobInvariant(job, run)
        assert.ok(violations.some((v) => v.code === 'job.running_without_matching_run'))
      })

      it(`should pass with valid ${state} shape`, () => {
        const job = buildJobAggregate({ state, activeRunId: 'run-1' })
        const run = buildActiveRun({ id: 'run-1' })
        const violations = validateJobInvariant(job, run)
        assert.strictEqual(violations.length, 0)
      })
    }
  })

  describe('queued states', () => {
    const QUEUED_STATES: JobState[] = ['planning_queued', 'execution_queued']

    for (const state of QUEUED_STATES) {
      it(`should reject active run in ${state}`, () => {
        const job = buildJobAggregate({ state, activeRunId: 'run-1' })
        const violations = validateJobInvariant(job, null)
        assert.ok(violations.some((v) => v.code === 'job.queued_has_active_run'))
      })

      it(`should pass with valid ${state} shape`, () => {
        const job = buildJobAggregate({ state, activeRunId: null })
        const violations = validateJobInvariant(job, null)
        assert.strictEqual(violations.length, 0)
      })
    }
  })
})
