import { describe, it } from 'node:test'
import assert from 'node:assert'
import type { JobAggregate, JobState } from '@shared/contracts/control-plane'
import {
  requestPause,
  continueJob,
  cancelJob,
  restartExecution,
  confirmPlan,
  replan
} from '@server/domain/jobs/job-state-machine'

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

const ALL_STATES: JobState[] = [
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

describe('requestPause', () => {
  it('should allow pause from planning_queued', () => {
    const job = buildJobAggregate({ state: 'planning_queued' })
    const result = requestPause(job)
    assert.strictEqual(result.ok, true)
    if (result.ok) {
      assert.strictEqual(result.value.nextState, 'paused')
      assert.strictEqual(result.value.controlIntent, 'none')
      assert.strictEqual(result.value.resumeTarget, 'planning_queued')
      assert.strictEqual(result.value.clearActiveRun, true)
    }
  })

  it('should allow pause from execution_queued', () => {
    const job = buildJobAggregate({ state: 'execution_queued' })
    const result = requestPause(job)
    assert.strictEqual(result.ok, true)
    if (result.ok) {
      assert.strictEqual(result.value.nextState, 'paused')
      assert.strictEqual(result.value.resumeTarget, 'execution_queued')
    }
  })

  it('should allow pause from planning_running', () => {
    const job = buildJobAggregate({ state: 'planning_running', activeRunId: 'run-1' })
    const result = requestPause(job)
    assert.strictEqual(result.ok, true)
    if (result.ok) {
      assert.strictEqual(result.value.nextState, 'pausing')
      assert.strictEqual(result.value.controlIntent, 'pause')
      assert.strictEqual(result.value.resumeTarget, 'planning_queued')
      assert.strictEqual(result.value.clearActiveRun, false)
    }
  })

  it('should allow pause from execution_running', () => {
    const job = buildJobAggregate({ state: 'execution_running', activeRunId: 'run-1' })
    const result = requestPause(job)
    assert.strictEqual(result.ok, true)
    if (result.ok) {
      assert.strictEqual(result.value.nextState, 'pausing')
      assert.strictEqual(result.value.controlIntent, 'pause')
      assert.strictEqual(result.value.resumeTarget, 'execution_queued')
    }
  })

  const DISALLOWED_STATES: JobState[] = ALL_STATES.filter(
    (s) => !['planning_queued', 'planning_running', 'execution_queued', 'execution_running'].includes(s)
  )

  for (const state of DISALLOWED_STATES) {
    it(`should reject pause from ${state}`, () => {
      const job = buildJobAggregate({ state })
      const result = requestPause(job)
      assert.strictEqual(result.ok, false)
      if (!result.ok) {
        assert.strictEqual(result.error.code, 'job.action_not_allowed')
      }
    })
  }
})

describe('continueJob', () => {
  it('should allow continue from paused with resume_target', () => {
    const job = buildJobAggregate({ state: 'paused', resumeTarget: 'execution_queued' })
    const result = continueJob(job)
    assert.strictEqual(result.ok, true)
    if (result.ok) {
      assert.strictEqual(result.value.nextState, 'execution_queued')
      assert.strictEqual(result.value.resumeTarget, null)
    }
  })

  it('should reject continue from paused without resume_target', () => {
    const job = buildJobAggregate({ state: 'paused', resumeTarget: null })
    const result = continueJob(job)
    assert.strictEqual(result.ok, false)
    if (!result.ok) {
      assert.strictEqual(result.error.code, 'job.invalid_resume_target')
    }
  })

  it('should allow continue from failed', () => {
    const job = buildJobAggregate({ state: 'failed' })
    const result = continueJob(job)
    assert.strictEqual(result.ok, true)
    if (result.ok) {
      assert.strictEqual(result.value.nextState, 'execution_queued')
    }
  })

  const DISALLOWED_STATES: JobState[] = ALL_STATES.filter(
    (s) => !['paused', 'failed'].includes(s)
  )

  for (const state of DISALLOWED_STATES) {
    it(`should reject continue from ${state}`, () => {
      const job = buildJobAggregate({ state })
      const result = continueJob(job)
      assert.strictEqual(result.ok, false)
      if (!result.ok) {
        assert.strictEqual(result.error.code, 'job.action_not_allowed')
      }
    })
  }
})

describe('cancelJob', () => {
  const ALLOWED_STATES: JobState[] = [
    'planning_queued',
    'planning_running',
    'plan_review',
    'execution_queued',
    'execution_running',
    'paused',
    'failed'
  ]

  for (const state of ALLOWED_STATES) {
    it(`should allow cancel from ${state}`, () => {
      const job = buildJobAggregate({ state })
      const result = cancelJob(job)
      assert.strictEqual(result.ok, true)
      if (result.ok) {
        assert.strictEqual(result.value.nextState, 'cancelled')
        assert.strictEqual(result.value.controlIntent, 'none')
        assert.strictEqual(result.value.clearActiveRun, true)
      }
    })
  }

  const DISALLOWED_STATES: JobState[] = ALL_STATES.filter((s) => !ALLOWED_STATES.includes(s))

  for (const state of DISALLOWED_STATES) {
    it(`should reject cancel from ${state}`, () => {
      const job = buildJobAggregate({ state })
      const result = cancelJob(job)
      assert.strictEqual(result.ok, false)
      if (!result.ok) {
        assert.strictEqual(result.error.code, 'job.action_not_allowed')
      }
    })
  }
})

describe('restartExecution', () => {
  it('should allow restart from failed', () => {
    const job = buildJobAggregate({ state: 'failed' })
    const result = restartExecution(job)
    assert.strictEqual(result.ok, true)
    if (result.ok) {
      assert.strictEqual(result.value.nextState, 'execution_queued')
    }
  })

  it('should allow restart from cancelled', () => {
    const job = buildJobAggregate({ state: 'cancelled' })
    const result = restartExecution(job)
    assert.strictEqual(result.ok, true)
    if (result.ok) {
      assert.strictEqual(result.value.nextState, 'execution_queued')
    }
  })

  const DISALLOWED_STATES: JobState[] = ALL_STATES.filter(
    (s) => !['failed', 'cancelled'].includes(s)
  )

  for (const state of DISALLOWED_STATES) {
    it(`should reject restart from ${state}`, () => {
      const job = buildJobAggregate({ state })
      const result = restartExecution(job)
      assert.strictEqual(result.ok, false)
      if (!result.ok) {
        assert.strictEqual(result.error.code, 'job.action_not_allowed')
      }
    })
  }
})

describe('confirmPlan', () => {
  it('should allow confirm from plan_review', () => {
    const job = buildJobAggregate({ state: 'plan_review' })
    const result = confirmPlan(job)
    assert.strictEqual(result.ok, true)
    if (result.ok) {
      assert.strictEqual(result.value.nextState, 'execution_queued')
    }
  })

  const DISALLOWED_STATES: JobState[] = ALL_STATES.filter((s) => s !== 'plan_review')

  for (const state of DISALLOWED_STATES) {
    it(`should reject confirm from ${state}`, () => {
      const job = buildJobAggregate({ state })
      const result = confirmPlan(job)
      assert.strictEqual(result.ok, false)
      if (!result.ok) {
        assert.strictEqual(result.error.code, 'job.action_not_allowed')
      }
    })
  }
})

describe('replan', () => {
  it('should allow replan from plan_review', () => {
    const job = buildJobAggregate({ state: 'plan_review' })
    const result = replan(job)
    assert.strictEqual(result.ok, true)
    if (result.ok) {
      assert.strictEqual(result.value.nextState, 'planning_queued')
    }
  })

  const DISALLOWED_STATES: JobState[] = ALL_STATES.filter((s) => s !== 'plan_review')

  for (const state of DISALLOWED_STATES) {
    it(`should reject replan from ${state}`, () => {
      const job = buildJobAggregate({ state })
      const result = replan(job)
      assert.strictEqual(result.ok, false)
      if (!result.ok) {
        assert.strictEqual(result.error.code, 'job.action_not_allowed')
      }
    })
  }
})
