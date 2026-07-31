import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { bootstrapRuntime, resetAppContextForTests } from '../../src/server/bootstrap.ts'
import { SettingsRevisionConflictError } from '../../src/server/context/settings-store.ts'
import {
  createProvidersConfig,
  parseProvidersConfigOverrides
} from '../../src/shared/providers/settings.ts'
import { loadProviderSettings, saveProviderSettings } from '../../src/server/settings/providers.ts'

test('Provider settings persist with CAS and apply only after restart', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'codetask-provider-settings-'))
  t.after(async () => {
    await resetAppContextForTests()
    rmSync(dataDir, { recursive: true, force: true })
  })
  const ctx = bootstrapRuntime({ dataDir })

  const initial = loadProviderSettings()
  assert.equal(initial.revision, 0)
  assert.equal(initial.applyMode, 'restart')
  assert.equal(initial.providers.codex.model, undefined)

  const saved = saveProviderSettings(
    {
      codex: {
        model: 'gpt-test',
        executable: { mode: 'auto' }
      },
      cursorcli: { approveMcps: false }
    },
    0
  )
  assert.equal(saved.revision, 1)
  assert.equal(saved.applyMode, 'restart')
  assert.equal(saved.providers.codex.model, 'gpt-test')
  assert.equal(saved.providers.cursorcli.approveMcps, false)
  assert.equal(loadProviderSettings().providers.codex.model, 'gpt-test')

  // The boot registry is immutable; saved settings become active on the next boot.
  assert.equal(ctx.providerRegistry.get('codex').settings.model, undefined)
  assert.throws(
    () => saveProviderSettings({ codex: { model: 'stale-write' } }, 0),
    SettingsRevisionConflictError
  )

  await resetAppContextForTests()
  const restarted = bootstrapRuntime({ dataDir })
  assert.equal(restarted.providerRegistry.get('codex').settings.model, 'gpt-test')
  assert.equal(restarted.providerRegistry.get('cursorcli').settings.approveMcps, false)
})

test('Provider settings reject unknown providers and misspelled fields', () => {
  assert.throws(
    () => createProvidersConfig(parseProvidersConfigOverrides({ unknown: {} })),
    /not a supported Provider/
  )
  assert.throws(
    () => parseProvidersConfigOverrides({ codex: { modle: 'typo' } }),
    /modle is not supported/
  )
  assert.throws(
    () =>
      parseProvidersConfigOverrides({
        codex: { executable: { mode: 'auto', path: '/must-not-be-ignored' } }
      }),
    /path requires mode path/
  )
})

test('Provider settings routes expose GET/PUT and an explicit restart apply contract', () => {
  const source = readFileSync(join(process.cwd(), 'src/server/routes/settings.ts'), 'utf8')
  const settingsSource = readFileSync(
    join(process.cwd(), 'src/server/settings/providers.ts'),
    'utf8'
  )
  assert.match(source, /routes\.get\('\/providers'/)
  assert.match(source, /routes\.put\('\/providers'/)
  assert.match(source, /SettingsRevisionConflictError/)
  assert.match(settingsSource, /applyMode: 'restart'/)
})
