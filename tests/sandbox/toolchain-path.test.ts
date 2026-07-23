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

function createExecutableNode(binDir: string): string {
  mkdirSync(binDir, { recursive: true })
  const nodePath = join(binDir, 'node')
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
      hostHome: join(root, 'home'),
      platform: 'linux'
    })
    assert.deepEqual(augmented.split(':'), [realpathSync.native(binDir), '/usr/bin'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('discovers Volta Node from the host profile when inherited PATH omits it', () => {
  const home = mkdtempSync(join(tmpdir(), 'codetask-volta-home-'))
  const voltaBin = join(home, '.volta', 'bin')
  createExecutableNode(voltaBin)
  try {
    assert.deepEqual(
      resolveHostNodeBinDirs({
        env: {},
        execPath: join(home, 'missing-runtime'),
        hostHome: home,
        platform: 'linux'
      }),
      [realpathSync.native(voltaBin)]
    )
  } finally {
    rmSync(home, { recursive: true, force: true })
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

test('sandbox policy grants read access to discovered host Volta binaries', () => {
  const home = mkdtempSync(join(tmpdir(), 'codetask-provider-volta-'))
  const voltaBin = join(home, '.volta', 'bin')
  createExecutableNode(voltaBin)
  try {
    const roots = resolveProviderReadRoots('claude-code', Object.freeze({ HOME: home, PATH: '' }))
    assert.ok(roots.includes(realpathSync.native(voltaBin)))
    assert.ok(roots.includes(realpathSync.native(join(home, '.volta'))))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
