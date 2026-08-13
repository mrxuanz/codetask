import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { Hono } from 'hono'
import {
  buildConversationScopeId,
  createAgentRuntime,
  toCanonicalProviderCode
} from '@codetask/agent-runtime'
import { composeConversationModule } from '@codetask/server-core'
import type { ConversationHttpEnv } from '../../packages/server-core/src/modules/conversation/http/conversation-routes.ts'
import { migration048ConversationModuleTables } from '../../packages/database/src/migrations/conversation.ts'

const root = join(import.meta.dirname, '../..')

function walk(dir: string, files: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git' || name.startsWith('._')) continue
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) walk(full, files)
    else if (/\.(ts|tsx|mjs|js)$/.test(name)) files.push(full)
  }
  return files
}

describe('conversation module (03)', () => {
  it('creates conversation, enqueues turn, completes via AgentRuntime', async () => {
    const db = new Database(':memory:')
    migration048ConversationModuleTables.up(db)

    let seenReadRoots: string[] | undefined
    let seenWorkspaceAccess: string | undefined
    let seenLease: { leaseId: string; ownerKind: string; ownerId: string } | undefined
    const runtime = createAgentRuntime({
      async *streamTurn(input) {
        seenReadRoots = input.readRoots
        seenWorkspaceAccess = input.workspaceAccess
        seenLease = input.workspaceLease
        yield { type: 'delta', content: 'hello' }
        yield { type: 'completed', reply: 'hello', runtimeSessionId: null }
      }
    })

    const module = composeConversationModule({
      db,
      agentRuntime: runtime,
      async resolveWorkspaceRoot({ projectId }) {
        return {
          projectId,
          workspaceRoot: '/tmp/ws',
          canonicalWorkspaceRoot: '/tmp/ws'
        }
      },
      leases: {
        tryAcquireExclusive: () => ({ leaseId: 'lease-1' }),
        release: () => {}
      },
      realtime: { publish: () => {} },
      attachments: {
        resolveForTurn({ attachmentIds }) {
          return {
            attachments: attachmentIds.map((id, index) => ({
              id,
              assetId: id,
              name: 'shot.png',
              mimeType: 'image/png',
              sizeBytes: 3,
              kind: 'image' as const,
              sortOrder: index
            })),
            readRoots: ['/tmp/att-root'],
            promptAppendix: '## Reference Attachments\npath: /tmp/att-root/shot.png'
          }
        }
      },
      maxConcurrentTurnsPerUser: 2
    })

    const actor = { userId: 'alice', sessionId: 's1' }
    const conversation = module.app.create(actor, 'proj-1', { title: 'Chat' })
    assert.equal(conversation.providerCode, 'codex')
    assert.equal(conversation.titleSource, 'manual')

    const accepted = module.app.enqueueTurn(actor, conversation.id, {
      message: 'describe image',
      attachmentIds: ['att-11111111-1111-4111-8111-111111111111'],
      idempotencyKey: 'idem-1'
    })
    assert.equal(accepted.status, 'queued')

    await module.advanceQueue(actor.userId)
    // Allow async turn runner to finish
    await new Promise((r) => setTimeout(r, 80))

    const messages = module.app.listMessages(actor, conversation.id)
    const user = messages.find((m) => m.role === 'user')
    assert.ok(user)
    assert.equal(user!.attachments?.length, 1)
    assert.equal(user!.attachments?.[0]?.name, 'shot.png')
    assert.ok(messages.some((m) => m.role === 'assistant' && m.content.includes('hello')))
    assert.deepEqual(seenReadRoots, ['/tmp/att-root'])
    assert.equal(seenWorkspaceAccess, 'exclusive-write')
    assert.equal(seenLease?.leaseId, 'lease-1')
    assert.equal(seenLease?.ownerKind, 'conversation')
    assert.ok(seenLease?.ownerId)
  })

  it('resumes same-provider history and seeds bounded DB history after provider switch', async () => {
    const db = new Database(':memory:')
    migration048ConversationModuleTables.up(db)
    const turns: Array<{
      provider: string
      prompt: string
      runtimeSessionId: string | null | undefined
    }> = []
    const runtime = createAgentRuntime({
      async *streamTurn(input) {
        turns.push({
          provider: input.provider,
          prompt: input.prompt,
          runtimeSessionId: input.runtimeSessionId
        })
        const reply = `reply-${turns.length}`
        yield {
          type: 'completed',
          reply,
          runtimeSessionId: `${input.provider}-session`
        }
      }
    })
    const module = composeConversationModule({
      db,
      agentRuntime: runtime,
      async resolveWorkspaceRoot({ projectId }) {
        return { projectId, workspaceRoot: '/tmp/ws', canonicalWorkspaceRoot: '/tmp/ws' }
      },
      leases: { tryAcquireExclusive: () => null, release: () => {} },
      realtime: { publish: () => {} },
      maxConcurrentTurnsPerUser: 1
    })
    const actor = { userId: 'alice', sessionId: 'switch-history' }
    const conversation = module.app.create(actor, 'proj-1', {
      title: 'Provider switch',
      providerCode: 'codex'
    })
    const runTurn = async (message: string, idempotencyKey: string): Promise<void> => {
      const accepted = module.app.enqueueTurn(actor, conversation.id, {
        message,
        attachmentIds: [],
        idempotencyKey
      })
      await module.advanceQueue(actor.userId)
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const state = module.app.getTurn(actor, conversation.id, accepted.turnId).state
        if (state === 'completed') return
        if (state === 'failed' || state === 'cancelled') assert.fail(`turn ended as ${state}`)
        await new Promise((resolve) => setTimeout(resolve, 2))
      }
      assert.fail('turn did not complete')
    }

    await runTurn('first question', 'switch-history-1')
    await runTurn('second question', 'switch-history-2')
    await module.app.switchProvider(actor, conversation.id, 'opencode')
    await runTurn('third question', 'switch-history-3')

    assert.equal(turns[0]?.prompt, 'first question')
    assert.equal(turns[0]?.runtimeSessionId, null)
    assert.equal(turns[1]?.prompt, 'second question')
    assert.equal(turns[1]?.runtimeSessionId, 'codex-session')
    assert.equal(turns[2]?.runtimeSessionId, null)
    assert.match(turns[2]?.prompt ?? '', /user \(codex\): first question/)
    assert.match(turns[2]?.prompt ?? '', /assistant \(codex\): reply-1/)
    assert.match(turns[2]?.prompt ?? '', /user: third question$/)
    db.close()
  })

  it('rejects draft/plan fields on turn body via route validation helper', () => {
    const source = readFileSync(
      join(root, 'packages/server-core/src/modules/conversation/http/conversation-routes.ts'),
      'utf8'
    )
    assert.match(source, /Draft\/Plan fields are not accepted/)
    assert.doesNotMatch(source, /generateDraft:\s*true/)
  })

  it('rejects malformed and structurally invalid HTTP request bodies', async () => {
    const db = new Database(':memory:')
    migration048ConversationModuleTables.up(db)
    const runtime = createAgentRuntime({
      async *streamTurn() {
        yield { type: 'completed', reply: '', runtimeSessionId: null }
      }
    })
    const module = composeConversationModule({
      db,
      agentRuntime: runtime,
      async resolveWorkspaceRoot({ projectId }) {
        return { projectId, workspaceRoot: '/tmp/ws', canonicalWorkspaceRoot: '/tmp/ws' }
      },
      leases: { tryAcquireExclusive: () => null, release: () => {} },
      realtime: { publish: () => {} }
    })
    const http = new Hono<ConversationHttpEnv>()
    http.use('*', async (c, next) => {
      c.set('actor', { userId: 'alice', sessionId: 's1' })
      c.set('requestId', 'request-validation-test')
      await next()
    })
    http.route('/', module.routes)

    const malformed = await http.request('/projects/proj-1/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{'
    })
    assert.equal(malformed.status, 400)
    assert.equal((await malformed.json()).requestId, 'request-validation-test')

    const wrongType = await http.request('/projects/proj-1/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 42 })
    })
    assert.equal(wrongType.status, 400)

    const unexpectedField = await http.request('/projects/proj-1/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ generateDraft: true })
    })
    assert.equal(unexpectedField.status, 400)

    const oversizedTitle = await http.request('/projects/proj-1/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'x'.repeat(257) })
    })
    assert.equal(oversizedTitle.status, 400)
    db.close()
  })

  it('paginates message history with a stable timestamp and id cursor', () => {
    const db = new Database(':memory:')
    migration048ConversationModuleTables.up(db)
    const runtime = createAgentRuntime({
      async *streamTurn() {
        yield { type: 'completed', reply: '', runtimeSessionId: null }
      }
    })
    const module = composeConversationModule({
      db,
      agentRuntime: runtime,
      async resolveWorkspaceRoot({ projectId }) {
        return { projectId, workspaceRoot: '/tmp/ws', canonicalWorkspaceRoot: '/tmp/ws' }
      },
      leases: { tryAcquireExclusive: () => null, release: () => {} },
      realtime: { publish: () => {} }
    })
    const actor = { userId: 'alice', sessionId: 's1' }
    const conversation = module.app.create(actor, 'proj-1', { title: 'History' })
    const insert = db.prepare(
      `INSERT INTO conversation_messages (
        id, conversation_id, turn_id, role, kind, content, provider_code, model,
        thinking_text, thinking_duration_ms, created_at
      ) VALUES (?, ?, NULL, 'user', 'text', ?, 'codex', NULL, NULL, NULL, ?)`
    )
    for (let index = 1; index <= 5; index += 1) {
      insert.run(
        `msg-${index}`,
        conversation.id,
        `message-${index}`,
        `2026-01-01T00:00:0${index}.000Z`
      )
    }

    const latest = module.app.listMessages(actor, conversation.id, 2)
    assert.deepEqual(
      latest.map((message) => message.content),
      ['message-4', 'message-5']
    )
    const older = module.app.listMessages(actor, conversation.id, 2, {
      createdAt: latest[0]!.createdAt,
      id: latest[0]!.id
    })
    assert.deepEqual(
      older.map((message) => message.content),
      ['message-2', 'message-3']
    )
  })

  it('marks interrupted active turns failed during startup reconciliation', () => {
    const db = new Database(':memory:')
    migration048ConversationModuleTables.up(db)
    const events: string[] = []
    const runtime = createAgentRuntime({
      async *streamTurn() {
        yield { type: 'completed', reply: '', runtimeSessionId: null }
      }
    })
    const module = composeConversationModule({
      db,
      agentRuntime: runtime,
      async resolveWorkspaceRoot({ projectId }) {
        return { projectId, workspaceRoot: '/tmp/ws', canonicalWorkspaceRoot: '/tmp/ws' }
      },
      leases: { tryAcquireExclusive: () => null, release: () => {} },
      realtime: { publish: (_topic, event) => events.push(event) }
    })
    const actor = { userId: 'alice', sessionId: 's1' }
    const conversation = module.app.create(actor, 'proj-1', { title: 'Restart' })
    const now = new Date().toISOString()
    db.prepare(
      `INSERT INTO conversation_turns (
        id, conversation_id, actor_id, state, input_text, provider_code, workspace_access,
        settings_snapshot_json, settings_hash, idempotency_key, request_hash, state_revision,
        user_message_id, assistant_message_id, last_error_json, created_at, admitted_at,
        started_at, completed_at
      ) VALUES (?, ?, ?, 'running', 'hello', 'codex', 'live-read', '{}', 'hash', 'idem',
        'request-hash', 2, NULL, NULL, NULL, ?, ?, ?, NULL)`
    ).run('turn-interrupted', conversation.id, actor.userId, now, now, now)

    module.startup()

    const turn = module.app.getTurn(actor, conversation.id, 'turn-interrupted')
    assert.equal(turn.state, 'failed')
    assert.equal(turn.lastError?.code, 'runtime.interrupted')
    assert.ok(turn.completedAt)
    assert.ok(events.includes('turn.failed'))
  })

  it('keeps durable turn events small and bounds each actor queue', () => {
    const db = new Database(':memory:')
    migration048ConversationModuleTables.up(db)
    const eventBytes: number[] = []
    const runtime = createAgentRuntime({
      async *streamTurn() {
        yield { type: 'completed', reply: '', runtimeSessionId: null }
      }
    })
    const module = composeConversationModule({
      db,
      agentRuntime: runtime,
      async resolveWorkspaceRoot({ projectId }) {
        return { projectId, workspaceRoot: '/tmp/ws', canonicalWorkspaceRoot: '/tmp/ws' }
      },
      leases: { tryAcquireExclusive: () => null, release: () => {} },
      realtime: {
        publish(_topic, event, payload) {
          const bytes = Buffer.byteLength(JSON.stringify(payload), 'utf8')
          if (event.startsWith('turn.')) eventBytes.push(bytes)
          if (bytes > 32 * 1024) throw new Error('realtime.payload_too_large')
        }
      },
      maxConcurrentTurnsPerUser: 0
    })
    const actor = { userId: 'queue-owner', sessionId: 's1' }
    const conversation = module.app.create(actor, 'proj-1', { title: 'Bounded queue' })
    const largeInput = 'x'.repeat(128 * 1024)

    const accepted = module.app.enqueueTurn(actor, conversation.id, {
      message: largeInput,
      attachmentIds: [],
      idempotencyKey: 'bounded-0'
    })
    assert.equal(accepted.status, 'queued')
    assert.equal(module.app.getTurn(actor, conversation.id, accepted.turnId).inputText, largeInput)
    assert.ok(eventBytes.every((bytes) => bytes < 32 * 1024))

    for (let index = 1; index < 100; index += 1) {
      module.app.enqueueTurn(actor, conversation.id, {
        message: `queued-${index}`,
        attachmentIds: [],
        idempotencyKey: `bounded-${index}`
      })
    }
    assert.throws(
      () =>
        module.app.enqueueTurn(actor, conversation.id, {
          message: 'one too many',
          attachmentIds: [],
          idempotencyKey: 'bounded-overflow'
        }),
      /queue is full/i
    )
    db.close()
  })

  it('waits for an active provider turn before deleting a conversation', async () => {
    const db = new Database(':memory:')
    migration048ConversationModuleTables.up(db)
    let providerStopped = false
    let scopeClosed = false
    const runtime = createAgentRuntime({
      async *streamTurn(_input, options) {
        await new Promise<void>((resolve) => {
          if (options.signal?.aborted) resolve()
          else options.signal?.addEventListener('abort', () => resolve(), { once: true })
        })
        providerStopped = true
        yield { type: 'completed', reply: '', runtimeSessionId: null }
      },
      async closeScopeImpl() {
        scopeClosed = true
      }
    })
    const module = composeConversationModule({
      db,
      agentRuntime: runtime,
      async resolveWorkspaceRoot({ projectId }) {
        return { projectId, workspaceRoot: '/tmp/ws', canonicalWorkspaceRoot: '/tmp/ws' }
      },
      leases: { tryAcquireExclusive: () => null, release: () => {} },
      realtime: { publish: () => {} }
    })
    const actor = { userId: 'alice', sessionId: 's1' }
    const conversation = module.app.create(actor, 'proj-1', { title: 'Delete safely' })
    const accepted = module.app.enqueueTurn(actor, conversation.id, {
      message: 'wait',
      attachmentIds: [],
      idempotencyKey: 'delete-active-turn'
    })

    for (let attempt = 0; attempt < 50; attempt += 1) {
      const state = module.app.getTurn(actor, conversation.id, accepted.turnId).state
      if (state === 'running') break
      await new Promise((resolve) => setTimeout(resolve, 2))
    }

    await module.app.delete(actor, conversation.id)
    assert.equal(providerStopped, true)
    assert.equal(scopeClosed, true)
    const remaining = db
      .prepare(`SELECT COUNT(*) AS count FROM conversation_turns WHERE conversation_id = ?`)
      .get(conversation.id) as { count: number }
    assert.equal(remaining.count, 0)
    assert.throws(() => module.app.get(actor, conversation.id), /Conversation not found/)
  })
})

describe('agent-runtime shared port (03)', () => {
  it('maps canonical provider codes and builds conversation scopes without create_task', () => {
    assert.equal(toCanonicalProviderCode('claude'), 'claude')
    assert.equal(toCanonicalProviderCode('claude-code'), 'claude')
    assert.equal(toCanonicalProviderCode('cursor'), 'cursor')
    const scope = buildConversationScopeId('conv1', 'codex')
    assert.equal(scope, 'conversation:conv1:provider:codex')
    assert.doesNotMatch(scope, /create_task/)
  })

  it('packages/agent-runtime has no create_task scope literals', () => {
    const source = readFileSync(join(root, 'packages/agent-runtime/src/index.ts'), 'utf8')
    assert.doesNotMatch(source, /create_task/)
    assert.match(source, /createAgentRuntime/)
    assert.match(source, /inspectScope/)
  })
})

describe('architecture boundaries (03 conversation)', () => {
  it('conversation module does not import design or execution modules', () => {
    const convRoot = join(root, 'packages/server-core/src/modules/conversation')
    const files = walk(convRoot)
    assert.ok(files.length > 0)
    for (const file of files) {
      const source = readFileSync(file, 'utf8')
      assert.equal(/modules\/design|modules\/execution/.test(source), false, file)
      assert.equal(/electron/.test(source), false, file)
      // HTTP may mention rejected Design field names when validating requests.
      if (!file.endsWith('conversation-routes.ts')) {
        assert.equal(/create_task|generateDraft|propose_task_draft/.test(source), false, file)
      }
    }
  })

  it('contracts expose ConversationDto without draft SSE', () => {
    const conversation = readFileSync(join(root, 'packages/contracts/src/conversation.ts'), 'utf8')
    assert.match(conversation, /ConversationDtoSchema/)
    assert.match(conversation, /CreateConversationTurnBodySchema/)
    assert.doesNotMatch(conversation, /generateDraft|createTaskMode|wizardPhase/)
    assert.equal(existsSync(join(root, 'src/shared/contracts/sse.ts')), false)
  })
})
