import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ASYNC_QUEUE_OVERFLOW_ERROR,
  createAsyncQueue
} from '../../src/server/agent-runtime/cursor-acp/async-queue'

test('createAsyncQueue without options preserves legacy push/iterate behavior', async () => {
  const queue = createAsyncQueue<number>()
  queue.push(1)
  queue.push(2)
  queue.close()

  const values: number[] = []
  for await (const value of queue.iterate()) {
    values.push(value)
  }
  assert.deepEqual(values, [1, 2])
})

test('createAsyncQueue throws when buffered values exceed hardMax', async () => {
  const queue = createAsyncQueue<number>({ hardMax: 2 })
  queue.push(1)
  queue.push(2)
  queue.push(3)

  await assert.rejects(
    async () => {
      for await (const _ of queue.iterate()) {
        // consume until overflow surfaces
      }
    },
    (error: unknown) => error === ASYNC_QUEUE_OVERFLOW_ERROR
  )
})

test('fail while consumer is waiting throws instead of returning done', async () => {
  const queue = createAsyncQueue<number>()
  const iter = queue.iterate()
  const pending = iter.next()
  queue.fail(ASYNC_QUEUE_OVERFLOW_ERROR)
  await assert.rejects(pending, ASYNC_QUEUE_OVERFLOW_ERROR)
})

test('hardMax delivers to waiter before failing on a full buffer', async () => {
  const queue = createAsyncQueue<number>({ hardMax: 1 })
  queue.push(1)

  const iter = queue.iterate()
  assert.deepEqual(await iter.next(), { value: 1, done: false })

  const pending = iter.next()
  queue.push(2)
  assert.deepEqual(await pending, { value: 2, done: false })
})

test('onHighWater fires once per high-water episode', async () => {
  let count = 0
  const queue = createAsyncQueue<number>({
    softMax: 1,
    onHighWater: () => {
      count += 1
    }
  })

  queue.push(1)
  assert.equal(count, 0)
  queue.push(2)
  assert.equal(count, 1)
  queue.push(3)
  assert.equal(count, 1)

  const iter = queue.iterate()
  assert.deepEqual(await iter.next(), { value: 1, done: false })
  assert.equal(count, 1)

  queue.push(2)
  assert.equal(count, 1)
})

test('onHighWater can fire again after buffer drains below softMax', async () => {
  let count = 0
  const queue = createAsyncQueue<number>({
    softMax: 1,
    onHighWater: () => {
      count += 1
    }
  })

  queue.push(1)
  queue.push(2)
  assert.equal(count, 1)

  const iter = queue.iterate()
  assert.deepEqual(await iter.next(), { value: 1, done: false })
  assert.deepEqual(await iter.next(), { value: 2, done: false })
  assert.equal(count, 1)

  queue.push(1)
  assert.equal(count, 1)
  queue.push(2)
  assert.equal(count, 2)
})
