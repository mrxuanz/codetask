import assert from 'node:assert/strict'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
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
import { spawnProviderCommandSync } from '../../src/server/providers/spawn.ts'

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
    assert.equal(first.resolvedPath, path)
    assert.equal(first.invocation.executable, path)
    assert.equal(first.canonicalPath, realpathSync(path))
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
      hostEnv: { Path: root, PATHEXT: '.EXE;.CMD' },
      platform: 'win32',
      installDirs: []
    })
    assert.ok(installation)
    assert.equal(installation.resolvedPath.toLowerCase(), path.toLowerCase())
    assert.equal(installation.invocation.executable.toLowerCase(), path.toLowerCase())
    assert.equal(installation.canonicalPath.toLowerCase(), realpathSync(path).toLowerCase())
    assert.deepEqual(installation.invocation.prefixArgs, [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('Windows PATH ignores an extensionless POSIX shim and selects the PATHEXT launcher', () => {
  const root = mkdtempSync(join(tmpdir(), 'cctask-provider-resolver-win-npm-shim-'))
  const unixShim = join(root, 'claude')
  const cmdShim = join(root, 'claude.cmd')
  writeFileSync(unixShim, '#!/bin/sh\nexec node cli.js "$@"\n')
  writeFileSync(cmdShim, '@echo off\r\nnode cli.js %*\r\n')
  const resolver = new DefaultProviderInstallationResolver()
  try {
    const installation = resolver.resolve('claude-code', {
      settings: {
        enabled: true,
        executable: { mode: 'auto' },
        approveMcps: false
      },
      hostEnv: { Path: root, PATHEXT: '.EXE;CMD' },
      platform: 'win32',
      installDirs: []
    })
    assert.ok(installation)
    assert.equal(installation.resolvedPath.toLowerCase(), cmdShim.toLowerCase())
    assert.equal(installation.invocation.executable.toLowerCase(), cmdShim.toLowerCase())
    assert.notEqual(installation.resolvedPath.toLowerCase(), unixShim.toLowerCase())
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('Windows auto discovery rejects a lone extensionless POSIX shim', () => {
  const root = mkdtempSync(join(tmpdir(), 'cctask-provider-resolver-win-bare-shim-'))
  writeFileSync(join(root, 'claude'), '#!/bin/sh\nexit 0\n')
  const resolver = new DefaultProviderInstallationResolver()
  try {
    const installation = resolver.resolve('claude-code', {
      settings: {
        enabled: true,
        executable: { mode: 'auto' },
        approveMcps: false
      },
      hostEnv: { Path: root, PATHEXT: '.EXE;.CMD' },
      platform: 'win32',
      installDirs: []
    })
    assert.equal(installation, null)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('an explicitly configured Windows extensionless executable remains authoritative', () => {
  const root = mkdtempSync(join(tmpdir(), 'cctask-provider-resolver-win-explicit-'))
  const path = join(root, 'claude')
  writeFileSync(path, 'explicit executable')
  const resolver = new DefaultProviderInstallationResolver()
  try {
    const installation = resolver.resolve('claude-code', {
      settings: {
        enabled: true,
        executable: { mode: 'path', path },
        approveMcps: false
      },
      hostEnv: {},
      platform: 'win32',
      installDirs: []
    })
    assert.ok(installation)
    assert.equal(installation.resolvedPath, path)
    assert.deepEqual(installation.invocation, {
      executable: path,
      prefixArgs: []
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('configured Windows PowerShell shims use a structured invocation', () => {
  const root = mkdtempSync(join(tmpdir(), 'cctask-provider-resolver-ps1-'))
  const path = join(root, 'opencode.ps1')
  writeFileSync(path, 'exit 0\r\n')
  const resolver = new DefaultProviderInstallationResolver()
  try {
    const installation = resolver.resolve('opencode', {
      settings: {
        enabled: true,
        executable: { mode: 'path', path },
        approveMcps: false
      },
      hostEnv: {},
      platform: 'win32',
      installDirs: []
    })
    assert.ok(installation)
    assert.equal(installation.resolvedPath, path)
    assert.equal(installation.canonicalPath, realpathSync(path))
    assert.deepEqual(installation.invocation, {
      executable: 'powershell.exe',
      prefixArgs: ['-NoProfile', '-NonInteractive', '-File', path]
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test(
  'PATH resolution preserves a symlink shim as argv0 while retaining canonical metadata',
  { skip: process.platform === 'win32' },
  () => {
    const root = mkdtempSync(join(tmpdir(), 'cctask-provider-resolver-shim-'))
    const shim = join(root, 'provider-dispatcher')
    const entry = join(root, 'opencode')
    writeFileSync(
      shim,
      '#!/bin/sh\nif [ "${0##*/}" = "opencode" ]; then printf "shim-ok"; exit 0; fi\nexit 41\n'
    )
    chmodSync(shim, 0o755)
    symlinkSync(shim, entry)
    const resolver = new DefaultProviderInstallationResolver()

    try {
      const installation = resolver.resolve('opencode', {
        settings: {
          enabled: true,
          executable: { mode: 'auto' },
          approveMcps: false
        },
        hostEnv: { PATH: root },
        platform: process.platform,
        installDirs: []
      })
      assert.ok(installation)
      assert.equal(installation.resolvedPath, entry)
      assert.equal(installation.invocation.executable, entry)
      assert.equal(installation.canonicalPath, realpathSync(shim))

      const result = spawnProviderCommandSync(installation.invocation, [], {
        cwd: root,
        env: { PATH: root }
      })
      assert.equal(result.status, 0)
      assert.equal(result.stdout, 'shim-ok')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
)

test(
  'configured symlink paths remain launch entries instead of canonical targets',
  { skip: process.platform === 'win32' },
  () => {
    const root = mkdtempSync(join(tmpdir(), 'cctask-provider-configured-shim-'))
    const target = join(root, 'dispatcher')
    const entry = join(root, 'codex')
    writeFileSync(target, '#!/bin/sh\nexit 0\n')
    chmodSync(target, 0o755)
    symlinkSync(target, entry)
    const resolver = new DefaultProviderInstallationResolver()

    try {
      const installation = resolver.resolve('codex', {
        settings: {
          enabled: true,
          executable: { mode: 'path', path: entry },
          approveMcps: false
        },
        hostEnv: {},
        platform: process.platform
      })
      assert.ok(installation)
      assert.equal(installation.resolvedPath, entry)
      assert.equal(installation.invocation.executable, entry)
      assert.equal(installation.canonicalPath, realpathSync(target))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
)
