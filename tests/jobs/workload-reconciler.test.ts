import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  workloadLeaseTtlSec,
  resetWorkloadRunControllersForTests
} from '../../src/server/legacy-control-plane/workload-slot-store'
import {
  startWorkloadReconciler,
  stopWorkloadReconcilerForTests
} from '../../src/server/legacy-control-plane/reconcile'

describe('workload reconciler', () => {
  it('defaults lease ttl to 90 minutes', () => {
    assert.equal(workloadLeaseTtlSec(), 90 * 60)
  })

  it('starts and stops periodic reconciler for tests', () => {
    resetWorkloadRunControllersForTests()
    startWorkloadReconciler()
    startWorkloadReconciler()
    stopWorkloadReconcilerForTests()
  })
})
