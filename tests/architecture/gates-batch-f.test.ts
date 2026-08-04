/**
 * Batch F architecture gates — canonical provider codes + provider-runtime-node ownership.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { ProviderCodeSchema, SettingsProviderCodeSchema } from '@codetask/contracts'
import { PROVIDER_CODES } from '@codetask/server-core/modules/settings'
import { RuntimeRegistry } from '../../src/server/context/runtime-registry'
import { SUPPORTED_CORE_CODES } from '../../src/shared/providers/codes'
import { createProviderRegistry } from '@codetask/provider-runtime-node'

const root = join(import.meta.dirname, '../..')

describe('architecture gates — Batch F', () => {
  it('SettingsProviderCodeSchema matches ProviderCodeSchema literals', () => {
    const settings = SettingsProviderCodeSchema.anyOf.map((entry) => entry.const).sort()
    const provider = ProviderCodeSchema.anyOf.map((entry) => entry.const).sort()
    assert.deepEqual(settings, provider)
    assert.deepEqual([...PROVIDER_CODES].sort(), provider)
    assert.equal(settings.includes('claude-code'), false)
    assert.equal(settings.includes('cursorcli'), false)
  })

  it('migration 061 canonical provider codes is registered', () => {
    const migration = join(root, 'packages/database/src/migrations/canonical-provider-codes.ts')
    const host = join(root, 'src/server/db/migrations/061_canonical_provider_codes.ts')
    const index = readFileSync(join(root, 'src/server/db/migrations/index.ts'), 'utf8')
    assert.equal(existsSync(migration), true)
    assert.equal(existsSync(host), true)
    assert.match(index, /migration061CanonicalProviderCodesHost/)
    assert.match(readFileSync(migration, 'utf8'), /version:\s*61/)
  })

  it('design-module listProviders uses descriptor profiles, not readOnlyCapable alone', () => {
    const source = readFileSync(join(root, 'src/server/design-module.ts'), 'utf8')
    assert.match(source, /supportedProfiles/)
    assert.doesNotMatch(
      source,
      /supportedProfiles:\s*core\.readOnlyCapable\s*\?\s*\(\s*\['chat-read'\]/
    )
  })

  it('RuntimeRegistry has production writers for conversation and planning', () => {
    const design = readFileSync(join(root, 'src/server/design-module.ts'), 'utf8')
    assert.match(design, /addInflightConversation/)
    assert.match(design, /removeInflightConversation/)
    assert.match(design, /tryStartJobPlanning/)
    assert.match(design, /endJobPlanning/)

    const registry = new RuntimeRegistry()
    registry.addInflightConversation('c1', 'alice')
    assert.equal(registry.isConversationInflight('c1'), true)
    assert.equal(registry.isThreadInflight('c1'), true)
    registry.removeInflightConversation('c1')
    assert.equal(registry.isConversationInflight('c1'), false)

    assert.equal(registry.tryStartJobPlanning('plan-1'), true)
    assert.equal(registry.hasInflightPlanning(), true)
    assert.equal(registry.endJobPlanning('plan-1'), true)
    assert.equal(registry.hasInflightPlanning(), false)
  })

  it('agent-runtime reuse policy is a leaf module without circular re-export', () => {
    const leaf = readFileSync(join(root, 'packages/agent-runtime/src/provider-runtime.ts'), 'utf8')
    const index = readFileSync(join(root, 'packages/agent-runtime/src/index.ts'), 'utf8')
    assert.doesNotMatch(leaf, /from ['"]\.\/index/)
    assert.match(leaf, /export function resolveReusePolicy/)
    assert.match(index, /from ['"]\.\/provider-runtime/)
  })

  it('conversation cursor scope parser returns conversationId', () => {
    const source = readFileSync(
      join(root, 'packages/provider-runtime-node/src/cursor-acp/conversation-cursor-directory.ts'),
      'utf8'
    )
    assert.match(source, /conversationId/)
    assert.doesNotMatch(source, /return \{ threadId:/)
  })

  it('provider-runtime-node owns registry and uses canonical driver codes only', () => {
    assert.equal(existsSync(join(root, 'packages/provider-runtime-node/src/index.ts')), true)
    assert.deepEqual([...SUPPORTED_CORE_CODES], ['codex', 'claude', 'opencode', 'cursor'])
    const registry = createProviderRegistry()
    const codes = registry
      .list()
      .map((d) => d.descriptor.code)
      .sort()
    assert.deepEqual(codes, ['claude', 'codex', 'cursor', 'opencode'])
    assert.equal(codes.includes('claude-code'), false)
    assert.equal(codes.includes('cursorcli'), false)

    const composition = readFileSync(
      join(root, 'packages/provider-runtime-node/src/providers/composition.ts'),
      'utf8'
    )
    assert.doesNotMatch(composition, /claude-code|cursorcli/)

    const manifest = JSON.parse(
      readFileSync(join(root, 'packages/provider-runtime-node/package.json'), 'utf8')
    ) as { exports?: Record<string, string> }
    assert.equal(manifest.exports?.['./providers/*'], './src/providers/*.ts')
    assert.equal(manifest.exports?.['./streamers/*'], './src/streamers/*.ts')
    assert.equal(manifest.exports?.['./cursor-acp/*'], './src/cursor-acp/*.ts')
  })

  it('src/server/providers and agent-runtime providers are re-export shims only', () => {
    const access = readFileSync(join(root, 'src/server/providers/access.ts'), 'utf8')
    assert.match(access, /@codetask\/provider-runtime-node/)
    assert.doesNotMatch(access, /class ProviderRegistry|createProviderRegistry\s*\(/)

    const streamerIndex = readFileSync(
      join(root, 'src/server/agent-runtime/providers/index.ts'),
      'utf8'
    )
    assert.match(streamerIndex, /@codetask\/provider-runtime-node/)
  })

  it('R2: no toHostProviderCode, no workload-lease-stub, design-module skips runner import', () => {
    const agentRuntime = readFileSync(join(root, 'packages/agent-runtime/src/index.ts'), 'utf8')
    assert.doesNotMatch(agentRuntime, /toHostProviderCode/)
    assert.doesNotMatch(agentRuntime, /HostProviderCode/)
    assert.doesNotMatch(agentRuntime, /CANONICAL_TO_HOST/)

    assert.equal(existsSync(join(root, 'src/server/infra/workload-lease-stub.ts')), false)

    const design = readFileSync(join(root, 'src/server/design-module.ts'), 'utf8')
    assert.doesNotMatch(design, /agent-runtime\/runner/)
    assert.match(design, /hostAgentTurnStreamer|host-streamer/)

    const processState = join(root, 'src/server/context/process-runtime-state.ts')
    assert.equal(existsSync(processState), true)
    const runtimeFacade = readFileSync(join(root, 'src/server/context/runtime-registry.ts'), 'utf8')
    assert.match(runtimeFacade, /process-runtime-state/)
    const jobFacade = readFileSync(
      join(root, 'src/server/context/job-execution-runtime.ts'),
      'utf8'
    )
    assert.match(jobFacade, /process-runtime-state/)
  })
})
