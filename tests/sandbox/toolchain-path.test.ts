import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import test from 'node:test'
import { buildSandboxEnv } from '../../src/server/sandbox/env'
import { resolveProviderReadRoots } from '../../src/server/sandbox/provider-read-roots'
import {
  augmentPathWithHostNode,
  resolveHostNodeBinDirs
} from '../../src/server/sandbox/toolchain-path'

function createExecutableNode(binDir: string, name = 'node'): string {
  mkdirSync(binDir, { recursive: true })
  const nodePath = join(binDir, name)
  writeFileSync(nodePath, '#!/bin/sh\nexit 0\n', 'utf8')
  chmodSync(nodePath, 0o755)
  return nodePath
}

test('runtime Node directory is prepended and PATH entries remain deduplicated', () => {
  const root = mkdtempSync(join(tmpdir(), 'codetask-node-path-'))
  const binDir = join(root, 'runtime', 'bin')
  const nodePath = createExecutableNode(binDir)
  try {
    const augmented = augmentPathWithHostNode(`${binDir}:/usr/bin`, {
      env: {},
      execPath: nodePath,
      platform: 'linux'
    })
    assert.deepEqual(augmented.split(':'), [realpathSync.native(binDir), '/usr/bin'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('discovers Node from an arbitrary manager directory already present on host PATH', () => {
  const home = mkdtempSync(join(tmpdir(), 'codetask-toolchain-home-'))
  const managerBin = join(home, 'future-manager', 'shims')
  createExecutableNode(managerBin)
  try {
    assert.deepEqual(
      resolveHostNodeBinDirs({
        env: { PATH: managerBin },
        execPath: join(home, 'missing-runtime'),
        platform: 'linux'
      }),
      [realpathSync.native(managerBin)]
    )
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('Windows discovery accepts case-insensitive Path and a node.exe entry', () => {
  const root = mkdtempSync(join(tmpdir(), 'codetask-windows-node-path-'))
  const managerBin = join(root, 'future-manager', 'bin')
  createExecutableNode(managerBin, 'node.exe')
  try {
    assert.deepEqual(
      resolveHostNodeBinDirs({
        env: { Path: managerBin },
        execPath: join(root, 'missing-runtime.exe'),
        platform: 'win32'
      }),
      [realpathSync.native(managerBin)]
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('sandbox worker PATH always exposes the Node runtime that launched CodeTask', () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), 'codetask-sandbox-node-'))
  try {
    const env = buildSandboxEnv({ runtimeRoot, providerEnv: { PATH: '/usr/bin' } })
    assert.ok(env.PATH?.split(delimiter).includes(dirname(process.execPath)))
  } finally {
    rmSync(runtimeRoot, { recursive: true, force: true })
  }
})

test('sandbox policy grants read access to a generic PATH toolchain container', () => {
  const home = mkdtempSync(join(tmpdir(), 'codetask-provider-toolchain-'))
  const managerRoot = join(home, 'future-manager')
  const managerBin = join(managerRoot, 'bin')
  createExecutableNode(managerBin)
  try {
    const roots = resolveProviderReadRoots(
      'claude-code',
      Object.freeze({ HOME: home, PATH: managerBin })
    )
    assert.ok(roots.includes(realpathSync.native(managerBin)))
    assert.ok(roots.includes(realpathSync.native(managerRoot)))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
