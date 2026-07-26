import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { bootstrapRuntime, resetAppContextForTests } from '../../src/server/bootstrap.ts'
import { createAppConfig } from '../../src/server/config/app-config.ts'
import { isOuterSandboxEnabled } from '../../src/server/sandbox/outer-sandbox-flag.ts'
import { resolveOuterSandboxEnabled } from '../../src/server/sandbox/outer-sandbox-policy.ts'

describe('outer sandbox AppConfig enablement', () => {
  afterEach(async () => {
    await resetAppContextForTests()
  })

  it('resolveOuterSandboxEnabled: desktop honors config; server forces on', () => {
    assert.equal(
      resolveOuterSandboxEnabled({ mode: 'desktop', outerSandboxEnabled: true }),
      true
    )
    assert.equal(
      resolveOuterSandboxEnabled({ mode: 'desktop', outerSandboxEnabled: false }),
      false
    )
    assert.equal(
      resolveOuterSandboxEnabled({ mode: 'server', outerSandboxEnabled: false }),
      true
    )
    assert.equal(
      resolveOuterSandboxEnabled({ mode: 'server', outerSandboxEnabled: true }),
      true
    )
  })

  it('createAppConfig defaults outerSandboxEnabled to true and accepts override', () => {
    assert.equal(createAppConfig().sandbox.outerSandboxEnabled, true)
    assert.equal(
      createAppConfig({ sandbox: { outerSandboxEnabled: false } }).sandbox.outerSandboxEnabled,
      false
    )
  })

  it('isOuterSandboxEnabled fails closed (on) when not bootstrapped', async () => {
    await resetAppContextForTests()
    assert.equal(isOuterSandboxEnabled(), true)
  })

  it('desktop mode disables via AppConfig override', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'codetask-outer-sandbox-desktop-'))
    try {
      bootstrapRuntime({
        dataDir,
        mode: 'desktop',
        config: { sandbox: { outerSandboxEnabled: false } }
      })
      assert.equal(isOuterSandboxEnabled(), false)
    } finally {
      await resetAppContextForTests()
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it('server mode ignores AppConfig disable', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'codetask-outer-sandbox-server-'))
    try {
      bootstrapRuntime({
        dataDir,
        mode: 'server',
        config: { sandbox: { outerSandboxEnabled: false } }
      })
      assert.equal(isOuterSandboxEnabled(), true)
    } finally {
      await resetAppContextForTests()
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it('host env CODETASK_DISABLE_OUTER_SANDBOX does not disable product flag', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'codetask-outer-sandbox-env-'))
    const prev = process.env.CODETASK_DISABLE_OUTER_SANDBOX
    process.env.CODETASK_DISABLE_OUTER_SANDBOX = '1'
    try {
      bootstrapRuntime({
        dataDir,
        mode: 'desktop',
        config: { sandbox: { outerSandboxEnabled: true } }
      })
      assert.equal(isOuterSandboxEnabled(), true)
    } finally {
      if (prev === undefined) {
        delete process.env.CODETASK_DISABLE_OUTER_SANDBOX
      } else {
        process.env.CODETASK_DISABLE_OUTER_SANDBOX = prev
      }
      await resetAppContextForTests()
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})
