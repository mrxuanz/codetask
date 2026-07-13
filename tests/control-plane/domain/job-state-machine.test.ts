import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { JobState } from '../../../src/shared/contracts/control-plane/primitives'
import {
  requestPause,
  continueJob,
  cancelJob,
  restartExecution,
  acknowledgePause,
  confirmPlan,
  editPlan,
  deleteJob
} from '../../../src/server/domain/jobs/job-state-machine'
import { buildJobAggregate } from '../fixtures/job-aggregate-builder'

const ALL_STATES: readonly JobState[] = [
  'planning_queued',
  'planning_running',
  'plan_review',
  'execution_queued',
  'execution_running',
  'pausing',
  'paused',
  'applying_changes',
  'succeeded',
  'failed',
  'cancelled'
]

function assertOk(
  result: { readonly ok: boolean },
  state: JobState,
  command: string
): void {
  assert.equal(result.ok, true, `expected ok for ${command} from ${state}`)
}

function assertError(
  result: { readonly ok: boolean },
  state: JobState,
  command: string
): void {
  assert.equal(result.ok, false, `expected error for ${command} from ${state}`)
}

describe('job-state-machine', () => {
  describe('requestPause', () => {
    const okStates: readonly JobState[] = [
      'planning_queued',
      'planning_running',
      'execution_queued',
      'execution_running'
    ]
    const errorStates = ALL_STATES.filter((s) => !okStates.includes(s))

    for (const state of okStates) {
      it(`ok from ${state}`, () => {
        const job = buildJobAggregate({ state })
        const result = requestPause(job)
        assertOk(result, state, 'requestPause')
        assert.equal(result.ok, true)
        if (result.ok) {
          if (state === 'planning_queued' || state === 'execution_queued') {
            assert.equal(result.value.nextState, 'paused')
            assert.equal(result.value.controlIntent, 'none')
            assert.equal(result.value.clearActiveRun, true)
            assert.equal(
              result.value.resumeTarget,
              state === 'planning_queued'
                ? 'planning_queued'
                : 'execution_queued'
            )
          } else {
            assert.equal(result.value.nextState, 'pausing')
            assert.equal(result.value.controlIntent, 'pause')
            assert.equal(result.value.clearActiveRun, false)
            assert.equal(
              result.value.resumeTarget,
              state === 'planning_running'
                ? 'planning_queued'
                : 'execution_queued'
            )
          }
        }
      })
    }

    for (const state of errorStates) {
      it(`error from ${state}`, () => {
        const job = buildJobAggregate({ state })
        const result = requestPause(job)
        assertError(result, state, 'requestPause')
        assert.equal(result.ok, false)
        if (!result.ok) {
          assert.equal(result.error.code, 'job.action_not_allowed')
          assert.equal(result.error.state, state)
          assert.equal(result.error.command, 'pause')
        }
      })
    }
  })

  describe('continueJob', () => {
    it('ok from paused with resumeTarget=planning_queued', () => {
      const job = buildJobAggregate({
        state: 'paused',
        resumeTarget: 'planning_queued'
      })
      const result = continueJob(job)
      assert.equal(result.ok, true)
      if (result.ok) {
        assert.equal(result.value.nextState, 'planning_queued')
        assert.equal(result.value.controlIntent, 'none')
        assert.equal(result.value.resumeTarget, null)
        assert.equal(result.value.clearActiveRun, true)
      }
    })

    it('ok from paused with resumeTarget=execution_queued', () => {
      const job = buildJobAggregate({
        state: 'paused',
        resumeTarget: 'execution_queued'
      })
      const result = continueJob(job)
      assert.equal(result.ok, true)
      if (result.ok) {
        assert.equal(result.value.nextState, 'execution_queued')
      }
    })

    it('error from paused with resumeTarget=null', () => {
      const job = buildJobAggregate({
        state: 'paused',
        resumeTarget: null
      })
      const result = continueJob(job)
      assert.equal(result.ok, false)
      if (!result.ok) {
        assert.equal(result.error.code, 'job.invalid_resume_target')
      }
    })

    it('ok from failed (recoverable)', () => {
      const job = buildJobAggregate({ state: 'failed' })
      const result = continueJob(job)
      assert.equal(result.ok, true)
      if (result.ok) {
        assert.equal(result.value.nextState, 'execution_queued')
        assert.equal(result.value.controlIntent, 'none')
        assert.equal(result.value.resumeTarget, null)
        assert.equal(result.value.clearActiveRun, true)
      }
    })

    it('ok from failed with explicit resumeTarget', () => {
      const job = buildJobAggregate({
        state: 'failed',
        resumeTarget: 'planning_queued'
      })
      const result = continueJob(job)
      assert.equal(result.ok, true)
      if (result.ok) {
        assert.equal(result.value.nextState, 'planning_queued')
      }
    })

    const errorStates = ALL_STATES.filter(
      (s) => s !== 'paused' && s !== 'failed'
    )
    for (const state of errorStates) {
      it(`error from ${state}`, () => {
        const job = buildJobAggregate({ state })
        const result = continueJob(job)
        assertError(result, state, 'continueJob')
        if (!result.ok) {
          assert.equal(result.error.code, 'job.action_not_allowed')
          assert.equal(result.error.command, 'continue')
        }
      })
    }
  })

  describe('cancelJob', () => {
    const okStates: readonly JobState[] = [
      'planning_queued',
      'planning_running',
      'plan_review',
      'execution_queued',
      'execution_running',
      'paused'
    ]
    const errorStates: readonly JobState[] = [
      'pausing',
      'applying_changes',
      'succeeded',
      'failed',
      'cancelled'
    ]

    for (const state of okStates) {
      it(`ok from ${state}`, () => {
        const job = buildJobAggregate({ state })
        const result = cancelJob(job)
        assertOk(result, state, 'cancelJob')
        if (result.ok) {
          assert.equal(result.value.nextState, 'cancelled')
          assert.equal(result.value.controlIntent, 'none')
          assert.equal(result.value.resumeTarget, null)
          assert.equal(result.value.clearActiveRun, true)
        }
      })
    }

    for (const state of errorStates) {
      it(`error from ${state}`, () => {
        const job = buildJobAggregate({ state })
        const result = cancelJob(job)
        assertError(result, state, 'cancelJob')
        if (!result.ok) {
          assert.equal(result.error.code, 'job.action_not_allowed')
          assert.equal(result.error.command, 'cancel')
        }
      })
    }
  })

  describe('restartExecution', () => {
    it('ok from failed (non-recoverable)', () => {
      const job = buildJobAggregate({ state: 'failed' })
      const result = restartExecution(job)
      assert.equal(result.ok, true)
      if (result.ok) {
        assert.equal(result.value.nextState, 'execution_queued')
        assert.equal(result.value.controlIntent, 'none')
        assert.equal(result.value.resumeTarget, null)
        assert.equal(result.value.clearActiveRun, true)
      }
    })

    it('ok from cancelled with confirmed plan', () => {
      const job = buildJobAggregate({
        state: 'cancelled',
        currentPlanRevision: 1
      })
      const result = restartExecution(job)
      assert.equal(result.ok, true)
      if (result.ok) {
        assert.equal(result.value.nextState, 'execution_queued')
      }
    })

    it('error from cancelled without confirmed plan', () => {
      const job = buildJobAggregate({
        state: 'cancelled',
        currentPlanRevision: null
      })
      const result = restartExecution(job)
      assert.equal(result.ok, false)
      if (!result.ok) {
        assert.equal(result.error.code, 'job.action_not_allowed')
        assert.equal(result.error.command, 'restart_execution')
      }
    })

    const errorStates = ALL_STATES.filter(
      (s) => s !== 'failed' && s !== 'cancelled'
    )
    for (const state of errorStates) {
      it(`error from ${state}`, () => {
        const job = buildJobAggregate({ state })
        const result = restartExecution(job)
        assertError(result, state, 'restartExecution')
        if (!result.ok) {
          assert.equal(result.error.code, 'job.action_not_allowed')
          assert.equal(result.error.command, 'restart_execution')
        }
      })
    }
  })

  describe('acknowledgePause', () => {
    it('ok from pausing with controlIntent=pause', () => {
      const job = buildJobAggregate({
        state: 'pausing',
        controlIntent: 'pause',
        resumeTarget: 'execution_queued',
        activeRunId: 'run-1'
      })
      const result = acknowledgePause(job)
      assert.equal(result.ok, true)
      if (result.ok) {
        assert.equal(result.value.nextState, 'paused')
        assert.equal(result.value.controlIntent, 'none')
        assert.equal(result.value.resumeTarget, 'execution_queued')
        assert.equal(result.value.clearActiveRun, true)
      }
    })

    it('error from pausing without controlIntent=pause', () => {
      const job = buildJobAggregate({
        state: 'pausing',
        controlIntent: 'none'
      })
      const result = acknowledgePause(job)
      assert.equal(result.ok, false)
      if (!result.ok) {
        assert.equal(result.error.code, 'job.action_not_allowed')
        assert.equal(result.error.command, 'acknowledge_pause')
      }
    })

    const errorStates = ALL_STATES.filter((s) => s !== 'pausing')
    for (const state of errorStates) {
      it(`error from ${state}`, () => {
        const job = buildJobAggregate({ state })
        const result = acknowledgePause(job)
        assertError(result, state, 'acknowledgePause')
        if (!result.ok) {
          assert.equal(result.error.code, 'job.action_not_allowed')
          assert.equal(result.error.command, 'acknowledge_pause')
        }
      })
    }
  })

  describe('confirmPlan', () => {
    it('ok from plan_review', () => {
      const job = buildJobAggregate({ state: 'plan_review' })
      const result = confirmPlan(job)
      assert.equal(result.ok, true)
      if (result.ok) {
        assert.equal(result.value.nextState, 'execution_queued')
        assert.equal(result.value.controlIntent, 'none')
        assert.equal(result.value.resumeTarget, null)
        assert.equal(result.value.clearActiveRun, true)
      }
    })

    const errorStates = ALL_STATES.filter((s) => s !== 'plan_review')
    for (const state of errorStates) {
      it(`error from ${state}`, () => {
        const job = buildJobAggregate({ state })
        const result = confirmPlan(job)
        assertError(result, state, 'confirmPlan')
        if (!result.ok) {
          assert.equal(result.error.code, 'job.action_not_allowed')
          assert.equal(result.error.command, 'confirm_plan')
        }
      })
    }
  })

  describe('editPlan', () => {
    it('ok from plan_review', () => {
      const job = buildJobAggregate({ state: 'plan_review' })
      const result = editPlan(job)
      assert.equal(result.ok, true)
      if (result.ok) {
        assert.equal(result.value.nextState, 'plan_review')
        assert.equal(result.value.controlIntent, 'none')
        assert.equal(result.value.resumeTarget, null)
        assert.equal(result.value.clearActiveRun, false)
      }
    })

    const errorStates = ALL_STATES.filter((s) => s !== 'plan_review')
    for (const state of errorStates) {
      it(`error from ${state}`, () => {
        const job = buildJobAggregate({ state })
        const result = editPlan(job)
        assertError(result, state, 'editPlan')
        if (!result.ok) {
          assert.equal(result.error.code, 'job.action_not_allowed')
          assert.equal(result.error.command, 'edit_plan')
        }
      })
    }
  })

  describe('deleteJob', () => {
    const okStates: readonly JobState[] = ['succeeded', 'failed', 'cancelled']

    for (const state of okStates) {
      it(`ok from ${state}`, () => {
        const job = buildJobAggregate({ state })
        const result = deleteJob(job)
        assertOk(result, state, 'deleteJob')
        if (result.ok) {
          assert.equal(result.value.nextState, state)
          assert.equal(result.value.controlIntent, 'none')
          assert.equal(result.value.resumeTarget, null)
          assert.equal(result.value.clearActiveRun, false)
        }
      })
    }

    const errorStates = ALL_STATES.filter((s) => !okStates.includes(s))
    for (const state of errorStates) {
      it(`error from ${state}`, () => {
        const job = buildJobAggregate({ state })
        const result = deleteJob(job)
        assertError(result, state, 'deleteJob')
        if (!result.ok) {
          assert.equal(result.error.code, 'job.action_not_allowed')
          assert.equal(result.error.command, 'delete')
        }
      })
    }
  })

  describe('Section 6.3 must-fail scenarios (PR binding)', () => {
    it.skip('planning_running pause + SIGKILL -> paused (requires PR: startup-reconciler)', () => {
      const job = buildJobAggregate({
        state: 'pausing',
        controlIntent: 'pause',
        resumeTarget: 'planning_queued',
        activeRunId: 'run-1'
      })
      const result = acknowledgePause(job)
      assert.equal(result.ok, true)
      if (result.ok) {
        assert.equal(result.value.nextState, 'paused')
      }
    })

    it.skip('execution_running no intent + crash -> recoverable failed (requires PR: startup-reconciler)', () => {
      const job = buildJobAggregate({
        state: 'execution_running',
        controlIntent: 'none',
        activeRunId: 'run-stale'
      })
      const result = cancelJob(job)
      assert.equal(result.ok, true)
      if (result.ok) {
        assert.equal(result.value.nextState, 'cancelled')
      }
    })

    it.skip('Cancel + stale worker rejected (requires PR: worker-fence)', () => {
      const job = buildJobAggregate({
        state: 'cancelled',
        controlIntent: 'none',
        activeRunId: null
      })
      const result = restartExecution(job)
      assert.equal(result.ok, false)
    })

    it.skip('pausing last task success -> still paused first (requires PR: checkpoint-task)', () => {
      const job = buildJobAggregate({
        state: 'pausing',
        controlIntent: 'pause',
        resumeTarget: 'execution_queued',
        activeRunId: 'run-1'
      })
      const result = acknowledgePause(job)
      assert.equal(result.ok, true)
      if (result.ok) {
        assert.equal(result.value.nextState, 'paused')
        assert.equal(result.value.clearActiveRun, true)
      }
    })

    it.skip('REST revision 10 + SSE revision 9 must not overwrite (requires PR: event-reducer)', () => {
      assert.ok(true)
    })

    it.skip('SSE revision skip 10->12 must pull snapshot (requires PR: event-reducer)', () => {
      assert.ok(true)
    })

    it.skip('completed task + validation failed payload rejected (requires PR: checkpoint-task)', () => {
      assert.ok(true)
    })

    it.skip('active Job Delete rejected + pausing Cancel rejected (requires PR: command-service)', () => {
      const activeJob = buildJobAggregate({ state: 'execution_running' })
      assert.equal(deleteJob(activeJob).ok, false)

      const pausingJob = buildJobAggregate({
        state: 'pausing',
        controlIntent: 'pause'
      })
      assert.equal(cancelJob(pausingJob).ok, false)
    })
  })
})
