import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import {
  buildConversationScopeId,
  createAgentRuntime,
  toCanonicalProviderCode,
  toHostProviderCode
} from '@codetask/agent-runtime'
import { composeConversationModule } from '@codetask/server-core'
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

  it('rejects draft/plan fields on turn body via route validation helper', () => {
    const source = readFileSync(
      join(root, 'packages/server-core/src/modules/conversation/http/conversation-routes.ts'),
      'utf8'
    )
    assert.match(source, /Draft\/Plan fields are not accepted/)
    assert.doesNotMatch(source, /generateDraft:\s*true/)
  })
})

describe('agent-runtime shared port (03)', () => {
  it('maps host provider codes and builds conversation scopes without create_task', () => {
    assert.equal(toCanonicalProviderCode('claude-code'), 'claude')
    assert.equal(toHostProviderCode('claude'), 'claude-code')
    assert.equal(toCanonicalProviderCode('cursorcli'), 'cursor')
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
