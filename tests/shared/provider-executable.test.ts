import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { SUPPORTED_CORE_CODES } from '../../src/server/conversation/cores.ts'
import { PROVIDER_CLI_CANDIDATES } from '../../src/server/providers/commands.ts'
import { resolveProviderExecutable } from '../../src/server/providers/executable.ts'
import { ProviderInstallationError } from '../../src/server/providers/installation.ts'

test('PROVIDER_CLI_CANDIDATES covers every supported provider with stable non-empty lists', () => {
  for (const code of SUPPORTED_CORE_CODES) {
    const candidates = PROVIDER_CLI_CANDIDATES[code]
    assert.ok(Array.isArray(candidates), `${code} candidates should be an array`)
    assert.ok(candidates.length > 0, `${code} candidates should be non-empty`)
    for (const name of candidates) {
      assert.equal(typeof name, 'string')
      assert.ok(name.trim().length > 0)
    }
  }

  assert.deepEqual([...PROVIDER_CLI_CANDIDATES.codex], ['codex'])
  assert.deepEqual([...PROVIDER_CLI_CANDIDATES['claude-code']], ['claude', 'claude-code'])
  assert.deepEqual([...PROVIDER_CLI_CANDIDATES.opencode], ['opencode'])
  assert.deepEqual([...PROVIDER_CLI_CANDIDATES.cursorcli], ['agent', 'cursor-agent'])
})

test('typed OpenCode executable path is used for detect resolution', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cctask-opencode-bin-'))
  const bin = join(dir, 'opencode-custom')
  writeFileSync(bin, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  chmodSync(bin, 0o755)

  try {
    const resolved = resolveProviderExecutable('opencode', {
      settings: {
        enabled: true,
        executable: { mode: 'path', path: bin },
        approveMcps: false
      },
      env: {},
      installDirs: []
    })
    assert.ok(resolved, 'expected opencode executable to resolve')
    assert.equal(resolved.executable, bin)
    assert.equal(resolved.source, 'app-config')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('typed Cursor executable path is used for detect resolution', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cctask-cursor-bin-'))
  const bin = join(dir, 'agent-custom')
  writeFileSync(bin, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  chmodSync(bin, 0o755)

  try {
    const resolved = resolveProviderExecutable('cursorcli', {
      settings: {
        enabled: true,
        executable: { mode: 'path', path: bin },
        approveMcps: true
      },
      env: {},
      installDirs: []
    })
    assert.ok(resolved, 'expected cursorcli executable to resolve')
    assert.equal(resolved.executable, bin)
    assert.equal(resolved.source, 'app-config')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('typed executable path wins over PATH resolution for Codex', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cctask-codex-priority-'))
  const bin = join(dir, 'codex-custom')
  writeFileSync(bin, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  chmodSync(bin, 0o755)

  try {
    const resolved = resolveProviderExecutable('codex', {
      settings: {
        enabled: true,
        executable: { mode: 'path', path: bin },
        approveMcps: false
      },
      env: { PATH: '/usr/bin' },
      installDirs: []
    })
    assert.ok(resolved)
    assert.equal(resolved.executable, bin)
    assert.equal(resolved.source, 'app-config')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('missing configured path fails explicitly instead of silently falling through', () => {
  const path = join(tmpdir(), 'cctask-missing-codex-bin')
  assert.throws(
    () =>
      resolveProviderExecutable('codex', {
        settings: {
          enabled: true,
          executable: { mode: 'path', path },
          approveMcps: false
        },
        env: {},
        installDirs: []
      }),
    (error) =>
      error instanceof ProviderInstallationError && error.code === 'configured-path-missing'
  )
})

test('repeated detect resolution returns the same Cursor installation identity', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cctask-cursor-core-'))
  const bin = join(dir, 'agent-custom')
  writeFileSync(bin, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  chmodSync(bin, 0o755)

  try {
    const options = {
      settings: {
        enabled: true,
        executable: { mode: 'path' as const, path: bin },
        approveMcps: true
      },
      env: {},
      installDirs: []
    }
    const first = resolveProviderExecutable('cursorcli', options)
    const second = resolveProviderExecutable('cursorcli', options)
    assert.ok(first)
    assert.ok(second)
    assert.equal(first.installationId, second.installationId)
    assert.equal(first.executable, bin)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
