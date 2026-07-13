import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { JobState } from '../../../src/shared/contracts/control-plane/primitives'
import {
  validateJobInvariant,
  hasInvariantViolations
} from '../../../src/server/domain/jobs/job-invariants'
import type { ActiveRunSummary } from '../../../src/server/domain/jobs/job-invariants'
import { buildJobAggregate } from '../fixtures/job-aggregate-builder'

function violationCodes(
  job: Parameters<typeof validateJobInvariant>[0],
  activeRun: ActiveRunSummary | null
): readonly string[] {
  return validateJobInvariant(job, activeRun).map((v) => v.code)
}

describe('job-invariants', () => {
  describe('valid aggregate → zero violations', () => {
    const validCases: ReadonlyArray<{ name: string; state: JobState }> = [
      { name: 'planning_queued', state: 'planning_queued' },
      { name: 'planning_running', state: 'planning_running' },
      { name: 'plan_review', state: 'plan_review' },
      { name: 'execution_queued', state: 'execution_queued' },
      { name: 'execution_running', state: 'execution_running' },
      { name: 'pausing', state: 'pausing' },
      { name: 'paused', state: 'paused' },
      { name: 'applying_changes', state: 'applying_changes' },
      { name: 'succeeded', state: 'succeeded' },
      { name: 'failed', state: 'failed' },
      { name: 'cancelled', state: 'cancelled' }
    ]

    for (const { name, state } of validCases) {
      it(`${name}: valid aggregate has zero violations`, () => {
        const isTerminal = state === 'succeeded' || state === 'failed' || state === 'cancelled'
        const isPaused = state === 'paused'
        const isPausing = state === 'pausing'
        const isRunning = state === 'execution_running' || state === 'planning_running'
        const isQueued = state === 'planning_queued' || state === 'execution_queued'

        const job = buildJobAggregate({
          state,
          controlIntent: isPausing ? 'pause' : 'none',
          resumeTarget: isPausing || isPaused ? 'execution_queued' : null,
          activeRunId: isRunning || isPausing ? 'run-1' : null,
          stateRevision: 1,
          executionGeneration: 1
        })
        const activeRun: ActiveRunSummary | null =
          isRunning || isPausing
            ? { id: 'run-1', state: 'running', fenceToken: 'fence-1' }
            : null

        const violations = validateJobInvariant(job, activeRun)
        assert.deepEqual(violations, [], `expected no violations for valid ${name}`)
      })
    }
  })

  describe('pausing without intent → violation', () => {
    it('pausing with controlIntent=none → job.pausing_without_intent', () => {
      const job = buildJobAggregate({
        state: 'pausing',
        controlIntent: 'none',
        resumeTarget: 'execution_queued',
        activeRunId: 'run-1'
      })
      const activeRun: ActiveRunSummary = { id: 'run-1', state: 'running', fenceToken: 'fence-1' }
      const codes = violationCodes(job, activeRun)
      assert.ok(codes.includes('job.pausing_without_intent'))
    })
  })

  describe('pausing without resumeTarget → violation', () => {
    it('pausing with resumeTarget=null → job.pausing_without_resume_target', () => {
      const job = buildJobAggregate({
        state: 'pausing',
        controlIntent: 'pause',
        resumeTarget: null,
        activeRunId: 'run-1'
      })
      const activeRun: ActiveRunSummary = { id: 'run-1', state: 'running', fenceToken: 'fence-1' }
      const codes = violationCodes(job, activeRun)
      assert.ok(codes.includes('job.pausing_without_resume_target'))
    })
  })

  describe('pausing without activeRun → violation', () => {
    it('pausing with activeRunId=null → job.pausing_without_active_run', () => {
      const job = buildJobAggregate({
        state: 'pausing',
        controlIntent: 'pause',
        resumeTarget: 'execution_queued',
        activeRunId: null
      })
      const codes = violationCodes(job, null)
      assert.ok(codes.includes('job.pausing_without_active_run'))
    })

    it('pausing with activeRun=null summary → job.pausing_without_active_run', () => {
      const job = buildJobAggregate({
        state: 'pausing',
        controlIntent: 'pause',
        resumeTarget: 'execution_queued',
        activeRunId: 'run-1'
      })
      const codes = violationCodes(job, null)
      assert.ok(codes.includes('job.pausing_without_active_run'))
    })

    it('pausing with mismatched activeRunId → job.pausing_without_active_run', () => {
      const job = buildJobAggregate({
        state: 'pausing',
        controlIntent: 'pause',
        resumeTarget: 'execution_queued',
        activeRunId: 'run-1'
      })
      const activeRun: ActiveRunSummary = { id: 'run-different', state: 'running', fenceToken: 'fence-1' }
      const codes = violationCodes(job, activeRun)
      assert.ok(codes.includes('job.pausing_without_active_run'))
    })
  })

  describe('paused with intent/activeRun/missing resumeTarget → violation', () => {
    it('paused with controlIntent=pause → job.paused_has_control_intent', () => {
      const job = buildJobAggregate({
        state: 'paused',
        controlIntent: 'pause',
        resumeTarget: 'execution_queued',
        activeRunId: null
      })
      const codes = violationCodes(job, null)
      assert.ok(codes.includes('job.paused_has_control_intent'))
    })

    it('paused with activeRunId set → job.paused_has_active_run', () => {
      const job = buildJobAggregate({
        state: 'paused',
        controlIntent: 'none',
        resumeTarget: 'execution_queued',
        activeRunId: 'run-1'
      })
      const codes = violationCodes(job, null)
      assert.ok(codes.includes('job.paused_has_active_run'))
    })

    it('paused with resumeTarget=null → job.paused_without_resume_target', () => {
      const job = buildJobAggregate({
        state: 'paused',
        controlIntent: 'none',
        resumeTarget: null,
        activeRunId: null
      })
      const codes = violationCodes(job, null)
      assert.ok(codes.includes('job.paused_without_resume_target'))
    })

    it('paused with all three violations', () => {
      const job = buildJobAggregate({
        state: 'paused',
        controlIntent: 'pause',
        resumeTarget: null,
        activeRunId: 'run-1'
      })
      const codes = violationCodes(job, null)
      assert.ok(codes.includes('job.paused_has_control_intent'))
      assert.ok(codes.includes('job.paused_has_active_run'))
      assert.ok(codes.includes('job.paused_without_resume_target'))
    })
  })

  describe('terminal with activeRun → violation', () => {
    for (const state of ['succeeded', 'failed', 'cancelled'] as const) {
      it(`${state} with activeRunId → job.terminal_has_active_run`, () => {
        const job = buildJobAggregate({
          state,
          controlIntent: 'none',
          activeRunId: 'run-1'
        })
        const codes = violationCodes(job, null)
        assert.ok(codes.includes('job.terminal_has_active_run'))
      })

      it(`${state} with controlIntent=pause → job.terminal_has_control_intent`, () => {
        const job = buildJobAggregate({
          state,
          controlIntent: 'pause',
          activeRunId: null
        })
        const codes = violationCodes(job, null)
        assert.ok(codes.includes('job.terminal_has_control_intent'))
      })

      it(`${state} with both activeRun and intent → two violations`, () => {
        const job = buildJobAggregate({
          state,
          controlIntent: 'pause',
          activeRunId: 'run-1'
        })
        const codes = violationCodes(job, null)
        assert.ok(codes.includes('job.terminal_has_active_run'))
        assert.ok(codes.includes('job.terminal_has_control_intent'))
      })
    }
  })

  describe('execution_running without activeRun → violation', () => {
    it('execution_running with activeRunId=null → job.execution_running_without_active_run', () => {
      const job = buildJobAggregate({
        state: 'execution_running',
        activeRunId: null
      })
      const codes = violationCodes(job, null)
      assert.ok(codes.includes('job.execution_running_without_active_run'))
    })
  })

  describe('planning_running without activeRun → violation', () => {
    it('planning_running with activeRunId=null → job.planning_running_without_active_run', () => {
      const job = buildJobAggregate({
        state: 'planning_running',
        activeRunId: null
      })
      const codes = violationCodes(job, null)
      assert.ok(codes.includes('job.planning_running_without_active_run'))
    })
  })

  describe('queued with activeRun → violation', () => {
    for (const state of ['planning_queued', 'execution_queued'] as const) {
      it(`${state} with activeRunId → job.queued_has_active_run`, () => {
        const job = buildJobAggregate({
          state,
          activeRunId: 'run-1'
        })
        const codes = violationCodes(job, null)
        assert.ok(codes.includes('job.queued_has_active_run'))
      })
    }
  })

  describe('Invalid resumeTarget → violation', () => {
    it('resumeTarget with invalid string → job.invalid_resume_target_value', () => {
      const job = buildJobAggregate({
        state: 'plan_review',
        resumeTarget: 'invalid_value' as 'planning_queued'
      })
      const codes = violationCodes(job, null)
      assert.ok(codes.includes('job.invalid_resume_target_value'))
    })

    it('valid resumeTarget=planning_queued → no violation', () => {
      const job = buildJobAggregate({
        state: 'paused',
        controlIntent: 'none',
        resumeTarget: 'planning_queued',
        activeRunId: null
      })
      const codes = violationCodes(job, null)
      assert.ok(!codes.includes('job.invalid_resume_target_value'))
    })

    it('valid resumeTarget=execution_queued → no violation', () => {
      const job = buildJobAggregate({
        state: 'paused',
        controlIntent: 'none',
        resumeTarget: 'execution_queued',
        activeRunId: null
      })
      const codes = violationCodes(job, null)
      assert.ok(!codes.includes('job.invalid_resume_target_value'))
    })

    it('null resumeTarget → no invalid_resume_target_value violation', () => {
      const job = buildJobAggregate({
        state: 'execution_queued',
        resumeTarget: null
      })
      const codes = violationCodes(job, null)
      assert.ok(!codes.includes('job.invalid_resume_target_value'))
    })
  })

  describe('Negative revision → violation', () => {
    it('stateRevision=0 → job.invalid_state_revision', () => {
      const job = buildJobAggregate({
        state: 'execution_queued',
        stateRevision: 0
      })
      const codes = violationCodes(job, null)
      assert.ok(codes.includes('job.invalid_state_revision'))
    })

    it('stateRevision=-1 → job.invalid_state_revision', () => {
      const job = buildJobAggregate({
        state: 'execution_queued',
        stateRevision: -1
      })
      const codes = violationCodes(job, null)
      assert.ok(codes.includes('job.invalid_state_revision'))
    })

    it('stateRevision=1 → no violation', () => {
      const job = buildJobAggregate({
        state: 'execution_queued',
        stateRevision: 1
      })
      const codes = violationCodes(job, null)
      assert.ok(!codes.includes('job.invalid_state_revision'))
    })
  })

  describe('Negative generation → violation', () => {
    it('executionGeneration=-1 → job.negative_execution_generation', () => {
      const job = buildJobAggregate({
        state: 'execution_queued',
        executionGeneration: -1
      })
      const codes = violationCodes(job, null)
      assert.ok(codes.includes('job.negative_execution_generation'))
    })

    it('executionGeneration=0 → no violation', () => {
      const job = buildJobAggregate({
        state: 'execution_queued',
        executionGeneration: 0
      })
      const codes = violationCodes(job, null)
      assert.ok(!codes.includes('job.negative_execution_generation'))
    })
  })

  describe('hasInvariantViolations helper', () => {
    it('returns false for empty violations', () => {
      assert.equal(hasInvariantViolations([]), false)
    })

    it('returns true for non-empty violations', () => {
      assert.equal(
        hasInvariantViolations([{ code: 'test', detail: 'test' }]),
        true
      )
    })
  })
})
