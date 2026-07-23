import assert from 'node:assert/strict'
import test from 'node:test'
import type { ProviderInstallation } from '../../src/shared/providers/installation.ts'
import { CODEX_DESCRIPTOR } from '../../src/shared/providers/descriptors/codex.ts'
import { DEFAULT_PROVIDERS_CONFIG } from '../../src/shared/providers/settings.ts'
import type { AgentTurnChunk } from '../../src/server/agent-runtime/types.ts'
import {
  buildProviderTurnContext,
  type ProviderDriver,
  type ProviderTurnContext
} from '../../src/server/providers/driver.ts'
import {
  ProviderRuntimeManager,
  resolveProviderReusePolicy
} from '../../src/server/providers/lifecycle.ts'

const installation: ProviderInstallation = {
  id: 'codex:lifecycle-test',
  provider: 'codex',
  command: process.execPath,
  source: 'app-config',
  invocation: { executable: process.execPath, prefixArgs: [] },
  resolvedPath: process.execPath
}

function createDriver(events: string[], seen: ProviderTurnContext[]): ProviderDriver {
  return {
    kind: 'production',
    descriptor: CODEX_DESCRIPTOR,
    settings: DEFAULT_PROVIDERS_CONFIG.codex,
    async discover() {
      return installation
    },
    installDirs() {
      return []
    },
    prepareAuth() {
      throw new Error('not used by lifecycle test')
    },
    preflight() {
      return undefined
    },
    supports() {
      return true
    },
    async prepareTurn(context) {
      seen.push(context)
      return {
        installation,
        reusePolicy: context.input.role === 'conversation' ? 'conversation-scoped' : 'one-shot',
        async *stream(): AsyncGenerator<AgentTurnChunk> {
          events.push('stream:delta')
          yield { type: 'delta', content: 'ok' }
          events.push('stream:completed')
          yield { type: 'completed', reply: 'ok', runtimeSessionId: null }
        },
        async cancel() {
          events.push('cancel')
        },
        async close() {
          events.push('close')
        }
      }
    },
    contributeSandboxPolicy() {
      return { readRoots: [], writeRoots: [], environment: {}, credentialSnapshots: [] }
    },
    async shutdown() {
      events.push('shutdown')
    }
  }
}

test('RuntimeManager reuse policy preserves write-turn isolation', () => {
  assert.equal(resolveProviderReusePolicy('conversation', 'chat-write'), 'one-shot')
  assert.equal(resolveProviderReusePolicy('conversation', 'chat-read'), 'conversation-scoped')
  assert.equal(
    resolveProviderReusePolicy('conversation', 'create-task-read'),
    'conversation-scoped'
  )
  assert.equal(resolveProviderReusePolicy('task-worker', 'task-sandbox'), 'one-shot')
})

test('RuntimeManager selects scope, injects settings, and publishes completed after close', async () => {
  const events: string[] = []
  const seen: ProviderTurnContext[] = []
  const driver = createDriver(events, seen)
  const manager = new ProviderRuntimeManager()

  for await (const chunk of manager.stream(
    driver,
    buildProviderTurnContext({
      input: {
        provider: 'codex',
        role: 'conversation',
        cwd: '/workspace',
        runtimeRoot: '/runtime/conversation-a',
        prompt: 'hello'
      },
      installation,
      authMode: 'runtime-copy'
    })
  )) {
    events.push(`consumer:${chunk.type}`)
  }

  assert.equal(seen[0]?.runtimeScope?.reusePolicy, 'conversation-scoped')
  assert.equal(seen[0]?.runtimeScope?.id, 'conversation:/runtime/conversation-a')
  assert.equal(seen[0]?.input.providerSettings, DEFAULT_PROVIDERS_CONFIG.codex)
  assert.deepEqual(events, [
    'stream:delta',
    'consumer:delta',
    'stream:completed',
    'close',
    'consumer:completed'
  ])
  assert.equal(manager.activeCount(), 0)

  await manager.closeAll()
  assert.equal(events.at(-1), 'shutdown')
  await assert.rejects(async () => {
    for await (const _chunk of manager.stream(
      driver,
      buildProviderTurnContext({
        input: {
          provider: 'codex',
          role: 'task-worker',
          cwd: '/workspace',
          runtimeRoot: '/runtime/task-a',
          prompt: 'blocked'
        },
        installation,
        authMode: 'runtime-copy'
      })
    )) {
      // no-op
    }
  }, /draining/)
})
