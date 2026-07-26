import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTestApplication } from '../../helpers/core/create-application.ts'

describe('fault: artifact half-write', () => {
  it('failed commit leaves artifact incomplete and not durable', async () => {
    const app = createTestApplication()
    app.artifactStore.failCommitWith = new Error('disk.full')

    const handle = await app.artifacts.beginWrite('art-half', 'raw_output')
    await handle.writeChunk('partial-bytes')
    await assert.rejects(() => handle.commit({ contentHash: 'abc' }), /disk\.full/)

    const meta = await app.artifacts.getMeta('art-half')
    assert.ok(meta)
    assert.equal(meta.incomplete, true)
    // Incomplete artifacts must not be treated as durable content
    assert.notEqual(meta.incomplete, false)
  })
})
