import assert from 'node:assert/strict'
import test from 'node:test'
import { readSandboxStdoutLines } from '../../src/server/sandbox/launcher'
import { SandboxError } from '../../src/server/sandbox/types'

test('stdout reader stops when cancellation arrives before child exit is observable', async () => {
  const controller = new AbortController()
  let reads = 0
  const handle = {
    readStdoutChunk: () => {
      reads += 1
      controller.abort()
      return Buffer.alloc(0)
    },
    pollExit: () => null
  }

  await assert.rejects(
    async () => {
      for await (const _line of readSandboxStdoutLines(handle as never, {
        keepReading: () => true,
        pollExit: () => null,
        signal: controller.signal
      })) {
        // no output expected
      }
    },
    (error: unknown) => {
      assert.ok(error instanceof SandboxError)
      assert.equal(error.code, 'sandbox.turn.cancelled')
      return true
    }
  )
  assert.equal(reads, 1)
})

test('stdout reader treats an already-closed child as exited', async () => {
  const handle = {
    readStdoutChunk: () => Buffer.alloc(0)
  }
  const lines: string[] = []

  for await (const line of readSandboxStdoutLines(handle as never, {
    keepReading: () => true,
    pollExit: () => {
      throw new SandboxError('sandbox child closed', 'sandbox.child_closed')
    }
  })) {
    lines.push(line)
  }

  assert.deepEqual(lines, [])
})
