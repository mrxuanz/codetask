import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeMilestoneVerificationVerdict } from '../../src/server/jobs/verification/types'

const baseVerdict = {
  status: 'needs-repair',
  confidence: 'medium',
  summary: 'Milestone evidence incomplete'
}

test('normalizeMilestoneVerificationVerdict accepts repairTasks with targetSliceId', () => {
  const verdict = normalizeMilestoneVerificationVerdict(
    {
      ...baseVerdict,
      repairTasks: [
        {
          instruction: 'Add missing validation UI',
          evidenceGap: 'Form errors not shown',
          targetSliceId: 'm1-s1'
        }
      ]
    },
    { milestoneId: 'm1' }
  )
  assert.equal(verdict.repairTasks[0]?.targetSliceId, 'm1-s1')
})

test('normalizeMilestoneVerificationVerdict accepts repairTasks with targetTaskId', () => {
  const verdict = normalizeMilestoneVerificationVerdict(
    {
      ...baseVerdict,
      repairTasks: [
        {
          instruction: 'Fix task output',
          evidenceGap: 'Task artifact missing',
          targetTaskId: 'm1-s2-t3'
        }
      ]
    },
    { milestoneId: 'm1' }
  )
  assert.equal(verdict.repairTasks[0]?.targetTaskId, 'm1-s2-t3')
})

test('normalizeMilestoneVerificationVerdict rejects repairTasks without target', () => {
  assert.throws(
    () =>
      normalizeMilestoneVerificationVerdict({
        ...baseVerdict,
        repairTasks: [{ instruction: 'Fix it', evidenceGap: 'Gap' }]
      }),
    /repairTasks\[0\] must include targetSliceId/
  )
})

test('normalizeMilestoneVerificationVerdict rejects needs-repair without repairTasks', () => {
  assert.throws(
    () =>
      normalizeMilestoneVerificationVerdict({
        status: 'needs-repair',
        confidence: 'low',
        summary: 'Broken'
      }),
    /needs-repair requires at least one repairTasks/
  )
})

test('normalizeMilestoneVerificationVerdict rejects repair target outside milestone', () => {
  assert.throws(
    () =>
      normalizeMilestoneVerificationVerdict(
        {
          ...baseVerdict,
          repairTasks: [
            {
              instruction: 'Fix other milestone',
              evidenceGap: 'Wrong scope',
              targetSliceId: 'm2-s1'
            }
          ]
        },
        { milestoneId: 'm1' }
      ),
    /outside milestone m1/
  )
})

test('normalizeMilestoneVerificationVerdict allows passed without repairTasks', () => {
  const verdict = normalizeMilestoneVerificationVerdict({
    status: 'passed',
    confidence: 'high',
    summary: 'All good'
  })
  assert.deepEqual(verdict.repairTasks, [])
})
