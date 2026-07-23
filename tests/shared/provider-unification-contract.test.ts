import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  SUPPORTED_CORE_CODES,
  createProvidersConfig,
  getProviderDescriptor,
  listProviderDescriptors,
  mergeProvidersConfigOverrides,
  normalizeProviderCode
} from '../../src/shared/providers/index.ts'
import { createAppConfig } from '../../src/server/config/app-config.ts'
import {
  DefaultProviderInstallationResolver,
  ProviderInstallationError
} from '../../src/server/providers/installation.ts'

test('provider aliases normalize from one shared source', () => {
  assert.equal(normalizeProviderCode(' CLAUDE_CODE '), 'claude-code')
  assert.equal(normalizeProviderCode('cursor-agent'), 'cursorcli')
  assert.equal(normalizeProviderCode('not-a-provider'), null)
})

test('serializable descriptors cover each provider exactly once', () => {
  const descriptors = listProviderDescriptors()
  assert.deepEqual(
    descriptors.map((descriptor) => descriptor.code),
    [...SUPPORTED_CORE_CODES]
  )
  for (const descriptor of descriptors) {
    assert.doesNotThrow(() => JSON.stringify(descriptor))
    assert.ok(descriptor.defaultCommands.length > 0)
    assert.ok(descriptor.capabilities.supportedProfiles.length > 0)
    assert.equal(getProviderDescriptor(descriptor.code), descriptor)
  }
})

test('typed provider config defaults to auto and supports explicit startup overrides', () => {
  const config = createAppConfig({
    providers: {
      codex: {
        executable: { mode: 'path', path: ' /opt/tools/codex ' },
        model: ' gpt-test '
      }
    }
  })
  assert.deepEqual(config.providers.codex.executable, {
    mode: 'path',
    path: '/opt/tools/codex'
  })
  assert.equal(config.providers.codex.model, 'gpt-test')
  assert.deepEqual(config.providers.opencode.executable, { mode: 'auto' })
})

test('typed provider config rejects empty paths and non-string models', () => {
  assert.throws(
    () =>
      createProvidersConfig({
        codex: { executable: { mode: 'path', path: ' ' } }
      }),
    /executable\.path/
  )
  assert.throws(
    () =>
      createProvidersConfig({
        codex: { model: 42 as unknown as string }
      }),
    /providers\.codex\.model/
  )
})

test('startup overrides win over persisted settings without mutating either source', () => {
  const persisted = {
    codex: { model: 'persisted-model', enabled: false },
    cursorcli: { endpoint: 'https://persisted.example' }
  }
  const startup = {
    codex: { model: 'startup-model' }
  }
  const merged = mergeProvidersConfigOverrides(persisted, startup)
  const config = createProvidersConfig(merged)
  assert.equal(config.codex.model, 'startup-model')
  assert.equal(config.codex.enabled, false)
  assert.equal(config.cursorcli.endpoint, 'https://persisted.example')
  assert.equal(persisted.codex.model, 'persisted-model')
})

test('resolver rejects configured missing paths and directories', () => {
  const root = mkdtempSync(join(tmpdir(), 'cctask-provider-resolver-invalid-'))
  const resolver = new DefaultProviderInstallationResolver()
  try {
    assert.throws(
      () =>
        resolver.resolve('codex', {
          settings: {
            enabled: true,
            executable: { mode: 'path', path: join(root, 'missing') },
            approveMcps: false
          },
          hostEnv: {},
          platform: 'linux'
        }),
      (error) =>
        error instanceof ProviderInstallationError && error.code === 'configured-path-missing'
    )
    mkdirSync(join(root, 'directory'))
    assert.throws(
      () =>
        resolver.resolve('codex', {
          settings: {
            enabled: true,
            executable: { mode: 'path', path: join(root, 'directory') },
            approveMcps: false
          },
          hostEnv: {},
          platform: 'linux'
        }),
      (error) =>
        error instanceof ProviderInstallationError && error.code === 'configured-path-not-file'
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('resolver rejects POSIX files without execute permission', () => {
  const root = mkdtempSync(join(tmpdir(), 'cctask-provider-resolver-mode-'))
  const path = join(root, 'codex')
  writeFileSync(path, '#!/bin/sh\n')
  chmodSync(path, 0o644)
  const resolver = new DefaultProviderInstallationResolver()
  try {
    assert.throws(
      () =>
        resolver.resolve('codex', {
          settings: {
            enabled: true,
            executable: { mode: 'path', path },
            approveMcps: false
          },
          hostEnv: {},
          platform: 'linux'
        }),
      (error) =>
        error instanceof ProviderInstallationError &&
        error.code === 'configured-path-not-executable'
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('resolver returns stable IDs for explicit POSIX executables', () => {
  const root = mkdtempSync(join(tmpdir(), 'cctask-provider-resolver-id-'))
  const path = join(root, 'codex')
  writeFileSync(path, '#!/bin/sh\nexit 0\n')
  chmodSync(path, 0o755)
  const resolver = new DefaultProviderInstallationResolver()
  const context = {
    settings: {
      enabled: true,
      executable: { mode: 'path' as const, path },
      approveMcps: false
    },
    hostEnv: {},
    platform: 'linux' as const
  }
  try {
    const first = resolver.resolve('codex', context)
    const second = resolver.resolve('codex', context)
    assert.ok(first)
    assert.ok(second)
    assert.equal(first.id, second.id)
    assert.equal(first.source, 'app-config')
    assert.equal(first.invocation.executable, realpathSync(path))
    assert.deepEqual(first.invocation.prefixArgs, [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('Windows PATH resolution represents cmd shims without shell strings', () => {
  const root = mkdtempSync(join(tmpdir(), 'cctask-provider-resolver-win-'))
  const path = join(root, 'agent.cmd')
  writeFileSync(path, '@echo off\r\nexit /b 0\r\n')
  const resolver = new DefaultProviderInstallationResolver()
  try {
    const installation = resolver.resolve('cursorcli', {
      settings: {
        enabled: true,
        executable: { mode: 'auto' },
        approveMcps: true
      },
      hostEnv: { PATH: root, PATHEXT: '.EXE;.CMD' },
      platform: 'win32',
      installDirs: []
    })
    assert.ok(installation)
    assert.equal(installation.resolvedPath.toLowerCase(), realpathSync(path).toLowerCase())
    assert.equal(installation.invocation.executable.toLowerCase(), realpathSync(path).toLowerCase())
    assert.deepEqual(installation.invocation.prefixArgs, [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
