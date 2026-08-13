import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import type { ChildProcess } from 'node:child_process'
import {
  configureSandboxTurnDebug,
  sandboxTurnDebug
} from '@codetask/agent-runtime/debug/sandbox-turn'
import { createChildDiagnostics } from '@codetask/provider-runtime-node/cursor-acp/acp-shared'

test('sandbox debug scrubs structured secrets before writing stderr', () => {
  const chunks: string[] = []
  const originalWrite = process.stderr.write
  process.stderr.write = ((chunk: string | Uint8Array) => {
    chunks.push(String(chunk))
    return true
  }) as typeof process.stderr.write
  try {
    configureSandboxTurnDebug({ enabled: true })
    sandboxTurnDebug('fixture', {
      authorization: 'Bearer top-secret-token',
      stderr: 'ANTHROPIC_API_KEY=sk-ant-secretfixture123456 at /Users/alice/project'
    })
  } finally {
    configureSandboxTurnDebug({ enabled: false })
    process.stderr.write = originalWrite
  }

  const output = chunks.join('')
  assert.match(output, /\[REDACTED\]/)
  assert.match(output, /\/Users\/\[USER\]/)
  assert.doesNotMatch(output, /top-secret-token|secretfixture|\/Users\/alice/)
})

test('Cursor diagnostics redact provider stderr before retaining its tail', async () => {
  const child = new EventEmitter() as ChildProcess
  const stderr = new PassThrough()
  Object.assign(child, { stderr })
  const diagnostics = createChildDiagnostics(child)

  stderr.write('Authorization: Bearer provider-secret-token /home/alice/work')
  await new Promise<void>((resolve) => setImmediate(resolve))

  const tail = diagnostics.getStderrTail()
  assert.match(tail, /\[REDACTED\]/)
  assert.match(tail, /\/home\/\[USER\]/)
  assert.doesNotMatch(tail, /provider-secret-token|\/home\/alice/)
  stderr.end()
})
