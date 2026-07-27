import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { openKernelDatabase } from '../../src/server/adapters/sqlite'
import { createConversationModule } from '../../src/server/composition/conversation'
import { createProviderRegistry } from '../../src/server/providers/composition'
import type { ProviderDriver } from '../../src/server/providers/driver'
import { createPreparedProviderTurn } from '../../src/server/providers/delegating-driver'
import type { AgentTurnChunk } from '../../src/server/agent-runtime/types'

test('conversation module exposes all host Providers and streams the selected thread driver', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'codetask-conversation-module-'))
  const workspaceRoot = join(root, 'workspace')
  const database = openKernelDatabase({ filename: ':memory:' })
  database.client
    .prepare(
      `INSERT INTO auth_users
         (id, singleton_key, username, normalized_username, password_hash,
          password_version, created_at_ms, updated_at_ms)
       VALUES ('user-1', 1, 'Alice', 'alice', 'hash', 1, 1, 1)`
    )
    .run()
  const base = createProviderRegistry().get('cursorcli')
  const installation = {
    id: 'cursorcli:test',
    provider: 'cursorcli' as const,
    command: 'agent',
    source: 'path' as const,
    invocation: { executable: 'agent', prefixArgs: [] },
    resolvedPath: 'agent',
    canonicalPath: 'agent'
  }
  const fakeDriver: ProviderDriver = {
    kind: 'test-fake',
    descriptor: base.descriptor,
    settings: base.settings,
    discover: async () => installation,
    installDirs: () => [],
    prepareAuth: ({ runtimeRoot }) => ({
      mode: 'host-identity',
      runtimeRoot,
      envPatch: {},
      readRoots: [],
      writeRoots: [],
      cleanupPlan: () => undefined,
      diagnostics: {
        provider: 'cursorcli',
        mode: 'host-identity',
        authMaterialPresent: true,
        warnings: []
      },
      filesystemProfile: {
        provider: 'cursorcli',
        hostReadRoots: [],
        hostWriteRoots: [],
        runtimeEnv: {},
        credentialSnapshots: [],
        scrubPatterns: []
      }
    }),
    preflight: () => undefined,
    supports: () => true,
    contributeSandboxPolicy: () => ({
      readRoots: [],
      writeRoots: [],
      environment: {},
      credentialSnapshots: []
    }),
    prepareTurn: async (turn) =>
      createPreparedProviderTurn({
        installation,
        turn,
        streamFactory: async function* (): AsyncGenerator<AgentTurnChunk> {
          yield { type: 'delta', content: 'Hello' }
          yield {
            type: 'completed',
            reply: 'Hello from Cursor',
            runtimeSessionId: 'cursor-session-1'
          }
        }
      })
  }
  const module = createConversationModule({
    database,
    runtimeRoot: join(root, 'runtime'),
    hostEnvironment: Object.freeze({ PATH: '/usr/bin', HOME: root }),
    cursorDriver: fakeDriver
  })

  t.after(async () => {
    await module.shutdown()
    database.close()
    rmSync(root, { recursive: true, force: true })
  })

  const workspace = module.service.createWorkspace('user-1', {
    rootPath: workspaceRoot,
    canonicalKey: workspaceRoot,
    title: 'Workspace'
  })
  const thread = module.service.createThread('user-1', {
    workspaceId: workspace.id,
    provider: 'cursorcli'
  })
  const statuses = await module.providerStatuses()
  assert.deepEqual(
    statuses.map((status) => status.code),
    ['codex', 'claude-code', 'opencode', 'cursorcli']
  )
  assert.equal(
    statuses.find((status) => status.code === 'cursorcli')?.authenticated,
    true
  )

  const events = []
  for await (const event of module.streamTurn({
    userId: 'user-1',
    threadId: thread.id,
    prompt: 'Say hello'
  })) {
    events.push(event)
  }

  assert.deepEqual(
    events.map((event) => event.type),
    ['started', 'delta', 'completed']
  )
  assert.deepEqual(
    module.service.listMessages('user-1', thread.id).map((message) => message.content),
    ['Say hello', 'Hello from Cursor']
  )
  assert.equal(
    module.service.listThreads('user-1', workspace.id)[0]?.runtimeSessionId,
    'cursor-session-1'
  )
})
