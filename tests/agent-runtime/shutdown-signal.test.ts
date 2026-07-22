import assert from 'node:assert/strict'
import test from 'node:test'
import { createShutdownSignalHandler } from '../../src/main/shutdown-signal'

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

test('shutdown signal exits cleanly after graceful shutdown resolves', async () => {
  const exits: number[] = []
  const handler = createShutdownSignalHandler({
    shutdown: async () => {},
    exit: (code) => exits.push(code),
    timeoutMs: 50
  })

  handler('SIGINT')
  await nextTurn()
  assert.deepEqual(exits, [0])
})

test('shutdown signal forces exit when graceful shutdown misses its deadline', async () => {
  const exits: number[] = []
  const handler = createShutdownSignalHandler({
    shutdown: () => new Promise<void>(() => {}),
    exit: (code) => exits.push(code),
    timeoutMs: 5
  })

  handler('SIGINT')
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.deepEqual(exits, [130])
})

test('a second shutdown signal forces immediate exit', () => {
  const exits: number[] = []
  const handler = createShutdownSignalHandler({
    shutdown: () => new Promise<void>(() => {}),
    exit: (code) => exits.push(code),
    timeoutMs: 60_000
  })

  handler('SIGTERM')
  handler('SIGINT')
  assert.deepEqual(exits, [130])
})
