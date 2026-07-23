import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { buildLaunchSpec } from '../../src/server/providers/launch-env.ts'

const FAKE_SECRET = 'super-secret-token-value-12345'

function withFakeCodexBin<T>(fn: (bin: string, cwd: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'cctask-launch-spec-'))
  const bin = join(dir, 'codex-fake')
  writeFileSync(bin, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  chmodSync(bin, 0o755)
  try {
    return fn(bin, dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('buildLaunchSpec resolves typed executable path and preserves explicit args', () => {
  withFakeCodexBin((bin, cwd) => {
    const spec = buildLaunchSpec('codex', {
      cwd,
      args: ['exec'],
      providerSettings: {
        enabled: true,
        executable: { mode: 'path', path: bin },
        approveMcps: false
      }
    })
    assert.equal(spec.executable, bin)
    assert.deepEqual(spec.args, ['exec'])
    assert.equal(spec.cwd, cwd)
    assert.equal('CODETASK_CODEX_BIN' in spec.env, false)
  })
})

test('buildLaunchSpec redactedSummary never contains secret overlay values', () => {
  withFakeCodexBin((bin, cwd) => {
    const spec = buildLaunchSpec('codex', {
      cwd,
      providerSettings: {
        enabled: true,
        executable: { mode: 'path', path: bin },
        approveMcps: false
      },
      providerOverlay: { OPENAI_API_KEY: FAKE_SECRET }
    })
    const summaryJson = JSON.stringify(spec.redactedSummary)
    assert.ok(!summaryJson.includes(FAKE_SECRET))
    assert.ok(!Object.values(spec.redactedSummary).some((v) => v === FAKE_SECRET))
    for (const entry of spec.redactedSummary.envVars) {
      assert.equal('value' in entry, false)
    }
    assert.equal(spec.executable, bin)
  })
})

test('LaunchSummary envVars include present flags', () => {
  withFakeCodexBin((bin, cwd) => {
    const spec = buildLaunchSpec('codex', {
      cwd,
      providerSettings: {
        enabled: true,
        executable: { mode: 'path', path: bin },
        approveMcps: false
      },
      providerOverlay: { OPENAI_API_KEY: 'set', CODEX_API_KEY: '' }
    })
    const openAi = spec.redactedSummary.envVars.find((v) => v.name === 'OPENAI_API_KEY')
    const codexKey = spec.redactedSummary.envVars.find((v) => v.name === 'CODEX_API_KEY')
    assert.ok(openAi)
    assert.equal(openAi.present, true)
    assert.ok(codexKey)
    assert.equal(codexKey.present, false)
  })
})
