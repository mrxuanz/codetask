import assert from 'node:assert/strict'
import test from 'node:test'
import { isDraftListEntryLaunched } from '../../src/shared/job-lifecycle.ts'

test('isDraftListEntryLaunched recognizes list and design-session launched states', () => {
  assert.equal(isDraftListEntryLaunched({ planStatus: 'launched' }), true)
  assert.equal(isDraftListEntryLaunched({ hasLaunchedJobId: true }), true)
  assert.equal(isDraftListEntryLaunched({ planStatus: 'plan_confirmed' }), true)
  assert.equal(isDraftListEntryLaunched({ planStatus: 'plan_editing' }), false)
  assert.equal(isDraftListEntryLaunched({ planStatus: 'planning' }), false)
  assert.equal(isDraftListEntryLaunched({ planStatus: 'failed' }), false)
  assert.equal(isDraftListEntryLaunched({ planStatus: 'cancelled' }), false)
  assert.equal(isDraftListEntryLaunched({ planStatus: 'failed', hasLaunchedJobId: true }), true)
})
