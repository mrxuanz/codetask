import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  prepareCursorAgentProcess,
  resolveCursorAgentExecutable
} from '../../src/server/agent-runtime/cursor-acp/command'
import {
  classifyCursorAcpError,
  probeCursorAgentAuth
} from '../../src/server/agent-runtime/cursor-acp/errors'
import { formatSdkTurnError } from '../../src/server/agent-runtime/errors'

function makeCursorAgentShim(output: string): { root: string; shim: string } {
  const root = join(
    tmpdir(),
    `codetask-cursor-agent-${Date.now()}-${Math.random().toString(16).slice(2)}`
  )
  const dir = join(root, 'cursor-agent')
  mkdirSync(dir, { recursive: true })
  const shim = join(dir, process.platform === 'win32' ? 'agent.cmd' : 'agent')
  const script =
    process.platform === 'win32'
      ? `@echo off\r\nif "%1"=="about" echo ${output}\r\n`
      : `#!/bin/sh\nif [ "$1" = "about" ]; then echo '${output}'; fi\n`
  writeFileSync(shim, script, { mode: 0o755 })
  return { root, shim }
}

test(
  'Cursor Agent command resolver finds Windows shim outside PATH',
  { skip: process.platform !== 'win32' },
  () => {
    const { root, shim } = makeCursorAgentShim('{"userEmail":"user@example.com"}')
    const env = { LOCALAPPDATA: root, PATH: '' }

    assert.equal(resolveCursorAgentExecutable('agent', env), shim)

    const prepared = prepareCursorAgentProcess('agent', env)
    assert.equal(prepared.executable, shim)
    assert.match(prepared.env.PATH, /cursor-agent/i)
  }
)

test(
  'Cursor Agent auth probe runs Windows cmd shims without relying on PATH',
  {
    skip: process.platform !== 'win32'
  },
  () => {
    const { root } = makeCursorAgentShim('{"userEmail":"user@example.com","cliVersion":"test"}')

    assert.equal(probeCursorAgentAuth('agent', { LOCALAPPDATA: root, PATH: '' }), null)
  }
)

test('Cursor Agent auth probe still reports a genuinely missing CLI', () => {
  const issue = probeCursorAgentAuth('codetask-definitely-missing-cursor-agent', { PATH: '' })

  assert.equal(issue?.code, 'provider.cursor.cli_missing')
})

test('formatSdkTurnError maps Cursor keepalive failures to a friendly message', () => {
  const raw = 'RetriableError: [internal] HTTP/2 keepalive ping timed out after 5000ms'
  assert.match(formatSdkTurnError(new Error(raw)), /cloud connection timed out/i)
  const classified = classifyCursorAcpError(new Error(raw))
  assert.equal(classified.code, 'provider.cursor.acp_keepalive_timeout')
  assert.match(classified.message, /cloud connection timed out/i)
})
