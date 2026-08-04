import assert from 'node:assert/strict'
import test from 'node:test'
import {
  jobIdFromRealtimeTopic,
  jobTopic,
  parseRealtimeTopic,
  conversationIdFromRealtimeTopic,
  conversationTopic,
  turnIdFromRealtimeTopic,
  conversationTurnTopic,
  SETTINGS_SELF_TOPIC
} from '../../packages/contracts/src/events.ts'
import { parseSseBlock } from '../../src/shared/sse'
import { LiveFanout } from '../../packages/server-core/src/modules/realtime/live-fanout.ts'

test('parseRealtimeTopic accepts canonical topics only', () => {
  assert.equal(parseRealtimeTopic('job:abc'), 'job:abc')
  assert.equal(parseRealtimeTopic('conversation:t1'), 'conversation:t1')
  assert.equal(parseRealtimeTopic('conversation-turn:u1'), 'conversation-turn:u1')
  assert.equal(parseRealtimeTopic(SETTINGS_SELF_TOPIC), SETTINGS_SELF_TOPIC)
  assert.equal(parseRealtimeTopic('thread:t1'), null)
  assert.equal(parseRealtimeTopic('turn:u1'), null)
  assert.equal(parseRealtimeTopic('other:x'), null)
  assert.equal(parseRealtimeTopic('job:'), null)
})

test('topic helpers round-trip ids', () => {
  assert.equal(jobIdFromRealtimeTopic(jobTopic('j1')), 'j1')
  assert.equal(conversationIdFromRealtimeTopic(conversationTopic('t1')), 't1')
  assert.equal(turnIdFromRealtimeTopic(conversationTurnTopic('x')), 'x')
  assert.equal(jobIdFromRealtimeTopic(conversationTopic('t1')), null)
})

test('parseSseBlock reads id field', () => {
  const parsed = parseSseBlock('id: 42\nevent: domain\ndata: {"eventId":42}')
  assert.ok(parsed)
  assert.equal(parsed?.id, '42')
  assert.equal(parsed?.event, 'domain')
})

test('LiveFanout coalesces progress events and broadcasts settings:self', () => {
  const fanout = new LiveFanout()
  const conn = {
    actorId: 'a1',
    sessionId: 's1',
    connectionId: 'c1',
    topics: new Set<string>(['job:j1', SETTINGS_SELF_TOPIC]),
    queue: [] as import('@codetask/contracts').RealtimeEnvelope[],
    queuedBytes: 0,
    lastDeliveredEventId: 0,
    resolveWait: null as (() => void) | null,
    closed: false,
    overflow: false
  }
  fanout.register(conn)

  fanout.publish('a1', {
    eventId: null,
    ephemeral: true,
    topic: 'job:j1',
    type: 'assistant.text.delta',
    entityId: 'j1',
    occurredAt: 1,
    payload: { content: 'a' }
  })
  fanout.publish('a1', {
    eventId: null,
    ephemeral: true,
    topic: 'job:j1',
    type: 'assistant.text.delta',
    entityId: 'j1',
    occurredAt: 2,
    payload: { content: 'b' }
  })
  assert.equal(conn.queue.length, 1)
  assert.deepEqual(conn.queue[0]?.payload, { content: 'b' })

  fanout.publish('other-actor', {
    eventId: 1,
    ephemeral: false,
    topic: SETTINGS_SELF_TOPIC,
    type: 'settings.changed',
    entityId: 'agent_defaults',
    entityRevision: 3,
    occurredAt: 3,
    payload: { namespace: 'agent_defaults', revision: 3 }
  })
  assert.equal(
    conn.queue.some((item) => item.type === 'settings.changed'),
    true
  )
  conn.closed = true
  fanout.unregister(LiveFanout.connectionKey('a1', 's1', 'c1'))
})
