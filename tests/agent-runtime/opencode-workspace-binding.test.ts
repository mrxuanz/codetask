import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ensureOpencodeSession } from '../../src/server/agent-runtime/providers/opencode-sdk'

test('OpenCode forks a resumed session that belongs to another workspace', async () => {
  const expected = mkdtempSync(join(tmpdir(), 'codetask-opencode-expected-'))
  const previous = mkdtempSync(join(tmpdir(), 'codetask-opencode-previous-'))
  const calls: Array<{ method: string; params: Record<string, unknown> }> = []
  const client = {
    session: {
      async get(params: Record<string, unknown>) {
        calls.push({ method: 'get', params })
        return {
          data: { id: 'old-session', directory: previous },
          error: undefined
        }
      },
      async fork(params: Record<string, unknown>) {
        calls.push({ method: 'fork', params })
        return {
          data: { id: 'forked-session', directory: expected },
          error: undefined
        }
      },
      async update(params: Record<string, unknown>) {
        calls.push({ method: 'update', params })
        return { data: { id: params.sessionID }, error: undefined }
      },
      async create() {
        throw new Error('session/create must not run for a successful rebind')
      }
    }
  }

  try {
    const sessionId = await ensureOpencodeSession(
      client as never,
      expected,
      'chat-write',
      'old-session',
      [previous]
    )
    assert.equal(sessionId, 'forked-session')
    assert.deepEqual(calls[1], {
      method: 'fork',
      params: { sessionID: 'old-session', directory: expected }
    })
    const update = calls[2]?.params
    assert.equal(update?.sessionID, 'forked-session')
    assert.equal(update?.directory, expected)
    assert.ok(
      Array.isArray(update?.permission) &&
        update.permission.some(
          (rule) =>
            rule.permission === 'external_directory' &&
            rule.pattern === '*' &&
            rule.action === 'deny'
        )
    )
    assert.ok(
      Array.isArray(update?.permission) &&
        update.permission.some(
          (rule) =>
            rule.permission === 'external_directory' &&
            rule.pattern === `${previous.replaceAll('\\', '/')}/**` &&
            rule.action === 'allow'
        )
    )
  } finally {
    rmSync(expected, { recursive: true, force: true })
    rmSync(previous, { recursive: true, force: true })
  }
})
