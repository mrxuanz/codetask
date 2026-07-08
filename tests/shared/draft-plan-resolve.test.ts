import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveDraftPlanReference } from '../../src/shared/draft-plan-resolve'

test('resolveDraftPlanReference keeps design session id during planning', () => {
  const refs = resolveDraftPlanReference({
    linkedPlanId: 'ds-plan-1',
    planId: 'ds-plan-1'
  })
  assert.equal(refs.designSessionId, 'ds-plan-1')
  assert.equal(refs.launchedJobId, null)
  assert.equal(refs.activePlanId, 'ds-plan-1')
})

test('resolveDraftPlanReference prefers launched job id after launch', () => {
  const refs = resolveDraftPlanReference({
    linkedPlanId: 'job-run-1',
    designSessionId: 'ds-plan-1',
    launchedJobId: 'job-run-1',
    planId: 'ds-plan-1'
  })
  assert.equal(refs.designSessionId, 'ds-plan-1')
  assert.equal(refs.launchedJobId, 'job-run-1')
  assert.equal(refs.activePlanId, 'job-run-1')
})

test('resolveDraftPlanReference recovers design session from payload after orphan job link', () => {
  const refs = resolveDraftPlanReference({
    linkedPlanId: 'job-missing',
    designSessionId: 'ds-plan-1',
    planId: 'ds-plan-1'
  })
  assert.equal(refs.designSessionId, 'ds-plan-1')
  assert.equal(refs.launchedJobId, 'job-missing')
  assert.equal(refs.activePlanId, 'job-missing')
})
