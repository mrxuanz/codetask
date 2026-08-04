import assert from 'node:assert/strict'
import test from 'node:test'
import {
  activeRealtimeKeys,
  bindRealtimeHandle,
  closeRealtimeForSession,
  closeRealtimeForUser,
  realtimeKey,
  resetRealtimeSessionRegistryForTests
} from '../../src/server/events/realtime-session-registry.ts'

function fakeHub(): {
  connectionId: string
  closed(): boolean
  close(): void
  setSubscriptions(): Promise<void>
  stream: AsyncGenerator<never, void, unknown>
} {
  let closed = false
  return {
    connectionId: 'conn-1',
    closed: () => closed,
    close() {
      closed = true
    },
    async setSubscriptions() {
      /* noop */
    },
    stream: (async function* () {
      /* empty */
    })()
  }
}

test('closeRealtimeForSession closes only matching session hubs', () => {
  resetRealtimeSessionRegistryForTests()
  const a = fakeHub()
  const b = fakeHub()
  bindRealtimeHandle('user-1', 'session-a', 'c1', a as never)
  bindRealtimeHandle('user-1', 'session-b', 'c2', b as never)

  closeRealtimeForSession('user-1', 'session-a')
  assert.equal(a.closed(), true)
  assert.equal(b.closed(), false)
  assert.deepEqual([...activeRealtimeKeys()], [realtimeKey('user-1', 'session-b', 'c2')])
  resetRealtimeSessionRegistryForTests()
})

test('closeRealtimeForUser closes all hubs for the account', () => {
  resetRealtimeSessionRegistryForTests()
  const a = fakeHub()
  const b = fakeHub()
  const other = fakeHub()
  bindRealtimeHandle('user-1', 'session-a', 'c1', a as never)
  bindRealtimeHandle('user-1', 'session-b', 'c2', b as never)
  bindRealtimeHandle('user-2', 'session-x', 'c3', other as never)

  closeRealtimeForUser('user-1')
  assert.equal(a.closed(), true)
  assert.equal(b.closed(), true)
  assert.equal(other.closed(), false)
  assert.deepEqual([...activeRealtimeKeys()], [realtimeKey('user-2', 'session-x', 'c3')])
  resetRealtimeSessionRegistryForTests()
})
