import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  openKernelDatabase,
  SqliteUnitOfWork,
  type KernelSqliteDatabase
} from '../../../src/server/adapters/sqlite'
import { ConversationService } from '../../../src/server/core/application/conversation'
import { ConversationError } from '../../../src/server/core/domain/conversation'

function createFixture(): {
  database: KernelSqliteDatabase
  service: ConversationService
} {
  const database = openKernelDatabase({ filename: ':memory:' })
  database.client
    .prepare(
      `INSERT INTO auth_users
         (id, singleton_key, username, normalized_username, password_hash,
          password_version, created_at_ms, updated_at_ms)
       VALUES ('user-1', 1, 'Alice', 'alice', 'hash', 1, 1, 1)`
    )
    .run()

  let nowMs = 100
  let sequence = 0
  const service = new ConversationService({
    unitOfWork: new SqliteUnitOfWork(database),
    clock: { nowMs: () => nowMs++ },
    ids: { generate: () => `id-${++sequence}` }
  })
  return { database, service }
}

describe('conversation SQLite application flow', () => {
  it('persists settings, workspaces, threads, turns and ordered messages', () => {
    const { database, service } = createFixture()
    try {
      assert.deepEqual(service.getSettings('user-1'), {
        userId: 'user-1',
        provider: 'codex',
        revision: 0,
        updatedAtMs: 0
      })
      assert.equal(service.updateSettings('user-1', { provider: 'claude-code' }).revision, 1)

      const workspace = service.createWorkspace('user-1', {
        rootPath: '/workspace',
        canonicalKey: '/workspace',
        title: 'Workspace'
      })
      const thread = service.createThread('user-1', { workspaceId: workspace.id })
      const started = service.beginTurn('user-1', thread.id, 'Build a small app')

      assert.equal(thread.provider, 'claude-code')
      assert.equal(started.turn.provider, 'claude-code')
      assert.deepEqual(started.history, [])
      assert.throws(
        () => service.beginTurn('user-1', thread.id, 'Concurrent turn'),
        (error: unknown) =>
          error instanceof ConversationError && error.code === 'conversation.turn_in_progress'
      )

      const assistant = service.completeTurn({
        turnId: started.turn.id,
        threadId: thread.id,
        reply: 'Done',
        runtimeSessionId: 'cursor-session-1'
      })
      assert.equal(assistant.role, 'assistant')
      assert.deepEqual(
        service
          .listMessages('user-1', thread.id)
          .map((message) => [message.sequence, message.role, message.content]),
        [
          [1, 'user', 'Build a small app'],
          [2, 'assistant', 'Done']
        ]
      )

      const threads = service.listThreads('user-1', workspace.id)
      assert.equal(threads[0]?.title, 'Build a small app')
      assert.equal(threads[0]?.runtimeSessionId, 'cursor-session-1')
      assert.equal(threads[0]?.lastMessageAtMs, assistant.createdAtMs)

      const switched = service.switchThreadProvider('user-1', thread.id, 'opencode')
      assert.equal(switched.provider, 'opencode')
      assert.equal(switched.runtimeSessionId, null)
      const resumed = service.beginTurn('user-1', thread.id, 'Continue with OpenCode')
      assert.equal(resumed.turn.provider, 'opencode')
      assert.deepEqual(
        resumed.history.map((message) => message.content),
        ['Build a small app', 'Done']
      )
    } finally {
      database.close()
    }
  })

  it('enforces one canonical workspace per user and cascades removal', () => {
    const { database, service } = createFixture()
    try {
      const workspace = service.createWorkspace('user-1', {
        rootPath: '/workspace',
        canonicalKey: '/workspace',
        title: 'Workspace'
      })
      const thread = service.createThread('user-1', { workspaceId: workspace.id })

      assert.throws(
        () =>
          service.createWorkspace('user-1', {
            rootPath: '/workspace',
            canonicalKey: '/workspace',
            title: 'Duplicate'
          }),
        (error: unknown) =>
          error instanceof ConversationError && error.code === 'conversation.workspace_exists'
      )

      service.deleteWorkspace('user-1', workspace.id)
      assert.equal(service.listWorkspaces('user-1').length, 0)
      assert.throws(
        () => service.listMessages('user-1', thread.id),
        (error: unknown) =>
          error instanceof ConversationError && error.code === 'conversation.thread_not_found'
      )
    } finally {
      database.close()
    }
  })
})
