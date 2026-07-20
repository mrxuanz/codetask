import assert from 'node:assert/strict'
import test from 'node:test'
import { pickNextPendingPlanningRow } from '../../src/server/design-session/planner'
import { isPlannerPlanCommitted } from '../../src/server/planner/mcp/session'

test('pickNextPendingPlanningRow skips user-paused rows at the head of the FIFO', () => {
  const paused = {
    id: 'job-paused',
    lastError: JSON.stringify({ code: 'job.paused', message: 'Paused' })
  }
  const runnable = {
    id: 'job-runnable',
    lastError: null
  }
  const next = pickNextPendingPlanningRow([paused, runnable])
  assert.equal(next?.id, 'job-runnable')
})

test('pickNextPendingPlanningRow returns undefined when every pending row is paused', () => {
  const pausedA = {
    id: 'a',
    lastError: JSON.stringify({ code: 'job.paused' })
  }
  const pausedB = {
    id: 'b',
    lastError: JSON.stringify({ code: 'job.paused' })
  }
  assert.equal(pickNextPendingPlanningRow([pausedA, pausedB]), undefined)
})

test('isPlannerPlanCommitted treats MCP commit as success even when turn ends in cancellation', () => {
  assert.equal(isPlannerPlanCommitted(false, { planCommitted: true }), true)
  assert.equal(isPlannerPlanCommitted(true, { planCommitted: false }), true)
  assert.equal(isPlannerPlanCommitted(false, { planCommitted: false }), false)
  assert.equal(isPlannerPlanCommitted(false, null), false)
})
