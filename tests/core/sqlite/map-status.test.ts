import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  mapLegacyJobStatus,
  UnmappableLegacyRowError
} from '../../../src/server/adapters/sqlite/index.ts'

describe('mapLegacyJobStatus', () => {
  it('maps known legacy aliases onto domain JobStatus', () => {
    assert.equal(mapLegacyJobStatus('pending'), 'queued')
    assert.equal(mapLegacyJobStatus('queued'), 'queued')
    assert.equal(mapLegacyJobStatus('ready'), 'queued')
    assert.equal(mapLegacyJobStatus('running'), 'running')
    assert.equal(mapLegacyJobStatus('executing'), 'running')
    assert.equal(mapLegacyJobStatus('pausing'), 'pausing')
    assert.equal(mapLegacyJobStatus('paused'), 'paused')
    assert.equal(mapLegacyJobStatus('verification'), 'verification')
    assert.equal(mapLegacyJobStatus('verifying'), 'verification')
    assert.equal(mapLegacyJobStatus('completed'), 'completed')
    assert.equal(mapLegacyJobStatus('success'), 'completed')
    assert.equal(mapLegacyJobStatus('succeeded'), 'completed')
    assert.equal(mapLegacyJobStatus('done'), 'completed')
    assert.equal(mapLegacyJobStatus('failed'), 'failed')
    assert.equal(mapLegacyJobStatus('error'), 'failed')
    assert.equal(mapLegacyJobStatus('cancelled'), 'cancelled')
    assert.equal(mapLegacyJobStatus('canceled'), 'cancelled')
  })

  it('fails closed on unknown status', () => {
    assert.throws(
      () => mapLegacyJobStatus('planning'),
      (err: unknown) =>
        err instanceof UnmappableLegacyRowError &&
        String(err.message).includes('Unmappable legacy job status')
    )
  })
})
