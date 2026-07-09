import assert from 'node:assert/strict'
import test from 'node:test'
import {
  jobIdFromTopic,
  jobTopic,
  parseHubTopic,
  threadIdFromTopic,
  threadTopic
} from '../../src/shared/contracts/job-event-hub'
import { parseSseBlock } from '../../src/shared/sse'
import { JobEventBus, enqueueHubEvent } from '../../src/server/context/event-bus'
import type { HubEvent } from '../../src/shared/contracts/job-event-hub'
import { registerJobHubConnection } from '../../src/server/events/job-event-hub'

test('parseHubTopic accepts job and thread topics', () => {
  assert.equal(parseHubTopic('job:abc'), 'job:abc')
  assert.equal(parseHubTopic('thread:t1'), 'thread:t1')
  assert.equal(parseHubTopic('other:x'), null)
  assert.equal(parseHubTopic('job:'), null)
})

test('topic helpers round-trip ids', () => {
  assert.equal(jobIdFromTopic(jobTopic('j1')), 'j1')
  assert.equal(threadIdFromTopic(threadTopic('t1')), 't1')
  assert.equal(jobIdFromTopic(threadTopic('t1')), null)
})

test('parseSseBlock reads id field', () => {
  const parsed = parseSseBlock('id: 42\nevent: hub\ndata: {"seq":42}')
  assert.ok(parsed)
  assert.equal(parsed?.id, '42')
  assert.equal(parsed?.event, 'hub')
})

test('JobEventBus fans out by topic', () => {
  const bus = new JobEventBus()
  const seen: HubEvent[] = []
  const unsub = bus.subscribe(jobTopic('j1'), (event) => {
    seen.push(event)
  })
  bus.emit(jobTopic('j1'), {
    event: 'error',
    data: { message: 'x' }
  })
  bus.emit(jobTopic('other'), {
    event: 'error',
    data: { message: 'y' }
  })
  assert.equal(seen.length, 1)
  assert.equal(seen[0].event, 'error')
  unsub()
})

test('enqueueHubEvent coalesces task_progress', () => {
  const queue: HubEvent[] = []
  enqueueHubEvent(queue, {
    event: 'task_progress',
    data: {
      taskProgress: { phase: 'running', status: 'running', currentIndex: 0, total: 1, tasks: [] }
    }
  })
  enqueueHubEvent(queue, {
    event: 'task_progress',
    data: {
      taskProgress: { phase: 'running', status: 'running', currentIndex: 2, total: 1, tasks: [] }
    }
  })
  assert.equal(queue.length, 1)
  if (queue[0].event === 'task_progress') {
    assert.equal(queue[0].data.taskProgress.currentIndex, 2)
  }
})

test('hub reconnect with unknown Last-Event-ID emits resync', async () => {
  const first = registerJobHubConnection('u-resync', 'conn-resync')
  first.close()

  const second = registerJobHubConnection('u-resync', 'conn-resync', { lastEventId: 99 })
  const iter = second.stream[Symbol.asyncIterator]()
  const firstChunk = await iter.next()
  assert.equal(firstChunk.done, false)
  assert.equal(firstChunk.value?.event, 'resync')
  second.close()
})
