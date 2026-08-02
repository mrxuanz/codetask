import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { bootstrapRuntime, resetAppContextForTests } from '../../src/server/bootstrap.ts'
import { SettingsError } from '@codetask/server-core/modules/settings'
import { getOrComposeSettings } from '../../src/server/settings/service.ts'

test('Provider settings persist with CAS and apply only after restart', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'codetask-provider-settings-'))
  t.after(async () => {
    await resetAppContextForTests()
    rmSync(dataDir, { recursive: true, force: true })
  })
  const ctx = bootstrapRuntime({ dataDir })
  const app = getOrComposeSettings(ctx).app

  const initial = app.getProviders({ providers: ctx.config.providers })
  assert.equal(initial.revision, 0)
  assert.equal(initial.restartRequired, false)
  assert.equal(initial.saved.providers.codex.model, undefined)

  const saved = await app.updateProviders(
    0,
    {
      providers: {
        codex: {
          enabled: true,
          executable: { mode: 'auto' },
          model: 'gpt-test',
          approveMcps: false
        },
        cursorcli: { enabled: true, executable: { mode: 'auto' }, approveMcps: false }
      }
    },
    { providers: ctx.config.providers }
  )
  assert.equal(saved.revision, 1)
  assert.equal(saved.restartRequired, true)
  assert.equal(saved.settings.providers.codex.model, 'gpt-test')
  assert.equal(app.getProviders({ providers: ctx.config.providers }).saved.providers.codex.model, 'gpt-test')

  assert.equal(ctx.providerRegistry.get('codex').settings.model, undefined)
  await assert.rejects(
    () =>
      app.updateProviders(
        0,
        { providers: { codex: { enabled: true, executable: { mode: 'auto' }, approveMcps: false, model: 'stale' } } },
        { providers: ctx.config.providers }
      ),
    (error: unknown) => error instanceof SettingsError && error.code === 'settings.revision_conflict'
  )

  await resetAppContextForTests()
  const restarted = bootstrapRuntime({ dataDir })
  assert.equal(restarted.providerRegistry.get('codex').settings.model, 'gpt-test')
  assert.equal(restarted.providerRegistry.get('cursorcli').settings.approveMcps, false)
})

test('Provider settings routes expose GET/PUT via settings module', () => {
  const source = readFileSync(join(process.cwd(), 'src/server/routes/settings.ts'), 'utf8')
  assert.match(source, /getOrComposeSettings/)
  assert.match(source, /createRoutes/)
  assert.match(source, /getEffectiveProviders/)
})
