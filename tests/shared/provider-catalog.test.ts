import assert from 'node:assert/strict'
import test from 'node:test'
import { SUPPORTED_CORE_CODES } from '../../src/shared/providers/codes.ts'
import { PROVIDER_CLI_CANDIDATES } from '../../src/server/providers/commands.ts'
import { createProviderRegistry } from '../../src/server/providers/composition.ts'

test('ProviderRegistry is the single server runtime catalog', () => {
  const registry = createProviderRegistry()
  const providers = registry.list()
  assert.equal(providers.length, SUPPORTED_CORE_CODES.length)

  const snapshot = providers.map((p) => ({
    code: p.descriptor.code,
    label: p.descriptor.label,
    commands: [...p.descriptor.defaultCommands]
  }))

  assert.deepEqual(
    snapshot,
    SUPPORTED_CORE_CODES.map((code) => ({
      code,
      label: registry.get(code).descriptor.label,
      commands: [...PROVIDER_CLI_CANDIDATES[code]]
    }))
  )

  for (const provider of providers) {
    assert.equal(typeof provider.discover, 'function')
    assert.equal(typeof provider.prepareAuth, 'function')
    assert.equal(typeof provider.preflight, 'function')
    assert.equal(typeof provider.prepareTurn, 'function')
    assert.equal(typeof provider.contributeSandboxPolicy, 'function')
  }
})
