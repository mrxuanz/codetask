import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  BoundedOutputBuffer,
  createBoundedOutput
} from '../../../src/server/core/application/runtime/bounded-output.ts'

describe('fault: stdout over limit', () => {
  it('ring buffer truncates and retains only the tail', () => {
    const buf = createBoundedOutput(8)
    buf.append('AAAA')
    buf.append('BBBB')
    buf.append('CCCC') // total seen 12; retain last 8

    assert.equal(buf.bytesSeen, 12)
    assert.equal(buf.bytesRetained, 8)
    assert.equal(buf.truncated, true)
    assert.equal(buf.tail().toString('utf8'), 'BBBBCCCC')
  })

  it('exposes BoundedOutput shape', () => {
    const buf: {
      bytesSeen: number
      bytesRetained: number
      truncated: boolean
      tail(): Buffer
    } = new BoundedOutputBuffer(4)
    buf.append('hello-world')
    assert.ok(buf.bytesSeen > buf.bytesRetained)
    assert.equal(buf.truncated, true)
    assert.ok(Buffer.isBuffer(buf.tail()))
  })
})
