import assert from 'node:assert/strict'
import test from 'node:test'
import { createBoundedBuffer } from '../../src/server/shared/bounded-buffer.ts'

test('close policy: push beyond max returns overflow, size stays at max', () => {
  const buf = createBoundedBuffer<number>({ max: 3, policy: 'close' })

  assert.equal(buf.push(1), 'ok')
  assert.equal(buf.push(2), 'ok')
  assert.equal(buf.push(3), 'ok')
  assert.equal(buf.size(), 3)

  assert.equal(buf.push(4), 'overflow')
  assert.equal(buf.size(), 3)
  assert.deepEqual(buf.toArray(), [1, 2, 3])
})

test('close policy: shift frees space for another push', () => {
  const buf = createBoundedBuffer<number>({ max: 2, policy: 'close' })

  buf.push(1)
  buf.push(2)
  assert.equal(buf.push(3), 'overflow')

  assert.equal(buf.shift(), 1)
  assert.equal(buf.size(), 1)

  assert.equal(buf.push(3), 'ok')
  assert.deepEqual(buf.toArray(), [2, 3])
})

test('drop-oldest policy: evicts oldest non-protected item, keeps protected', () => {
  const buf = createBoundedBuffer<number>({
    max: 3,
    policy: 'drop-oldest',
    isProtected: (n) => n % 2 === 0
  })

  buf.push(1) // non-protected
  buf.push(2) // protected
  buf.push(3) // non-protected

  buf.push(4) // evicts 1 (oldest non-protected), protected 2 stays
  assert.deepEqual(buf.toArray(), [2, 3, 4])
  assert.equal(buf.size(), 3)
})

test('drop-oldest policy: all protected still bounded, drops head', () => {
  const buf = createBoundedBuffer<number>({
    max: 2,
    policy: 'drop-oldest',
    isProtected: () => true
  })

  buf.push(1)
  buf.push(2)
  buf.push(3) // all protected — drops head as fallback

  assert.deepEqual(buf.toArray(), [2, 3])
  assert.equal(buf.size(), 2)
})

test('drop-oldest policy: under limit returns ok', () => {
  const buf = createBoundedBuffer<number>({ max: 5, policy: 'drop-oldest' })

  assert.equal(buf.push(1), 'ok')
  assert.equal(buf.push(2), 'ok')
  assert.equal(buf.size(), 2)
})
