import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveDraftPlanReference } from '../../src/shared/draft-plan-resolve'

test('resolveDraftPlanReference uses linked plan id during planning', () => {
  const refs = resolveDraftPlanReference({
    linkedPlanId: 'job-plan-1',
    planId: 'job-plan-1',
    planStatus: 'plan_editing'
  })
  assert.equal(refs.activePlanId, 'job-plan-1')
  assert.equal(refs.launchedJobId, null)
  assert.equal(refs.designSessionId, null)
})

test('resolveDraftPlanReference sets launchedJobId after planConfirmedAt', () => {
  const refs = resolveDraftPlanReference({
    linkedPlanId: 'job-plan-1',
    planId: 'job-plan-1',
    planConfirmedAt: 1_700_000_000,
    planStatus: 'pending'
  })
  assert.equal(refs.activePlanId, 'job-plan-1')
  assert.equal(refs.launchedJobId, 'job-plan-1')
})

test('resolveDraftPlanReference prefers explicit launchedJobId', () => {
  const refs = resolveDraftPlanReference({
    linkedPlanId: 'job-plan-1',
    designSessionId: 'ds-legacy',
    launchedJobId: 'job-plan-1',
    planId: 'job-plan-1'
  })
  assert.equal(refs.designSessionId, 'ds-legacy')
  assert.equal(refs.launchedJobId, 'job-plan-1')
  assert.equal(refs.activePlanId, 'job-plan-1')
})

test('resolveDraftPlanReference falls back to legacy designSessionId for activePlanId', () => {
  const refs = resolveDraftPlanReference({
    designSessionId: 'ds-plan-1',
    planStatus: 'planning'
  })
  assert.equal(refs.designSessionId, 'ds-plan-1')
  assert.equal(refs.activePlanId, 'ds-plan-1')
  assert.equal(refs.launchedJobId, null)
})
