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
    const prev = process.env.CODETASK_WORKLOAD_LEASE_TTL_SEC
    delete process.env.CODETASK_WORKLOAD_LEASE_TTL_SEC
    try {
      assert.equal(workloadLeaseTtlSec(), 90 * 60)
    } finally {
      if (prev === undefined) delete process.env.CODETASK_WORKLOAD_LEASE_TTL_SEC
      else process.env.CODETASK_WORKLOAD_LEASE_TTL_SEC = prev
    }
  })

  it('starts and stops periodic reconciler for tests', () => {
    resetWorkloadRunControllersForTests()
    startWorkloadReconciler()
    startWorkloadReconciler()
    stopWorkloadReconcilerForTests()
  })
})
