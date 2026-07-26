import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  installLiveProtectedRuntimeStub,
  ProtectedSpawnError,
  spawnProtectedProviderInvocation,
  uninstallProtectedRuntime
} from '../../../src/server/adapters/runtime/index.ts'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

function readSrc(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), 'utf8')
}

describe('protected spawn gateway (R1)', () => {
  it('claude / cursor / opencode launch sources use protected-spawn only', () => {
    const sites = [
      'src/server/providers/claude/sdk-spawn.ts',
      'src/server/agent-runtime/cursor-acp/command.ts',
      'src/server/agent-runtime/providers/opencode-sdk.ts'
    ]

    for (const site of sites) {
      const source = readSrc(site)
      assert.match(
        source,
        /spawnProtectedProviderInvocation/,
        `${site} must call spawnProtectedProviderInvocation`
      )
      assert.doesNotMatch(
        source,
        /\bspawnProviderInvocation\b/,
        `${site} must not reference spawnProviderInvocation`
      )
    }

    // Claude + OpenCode must not import providers/spawn at all.
    for (const site of [
      'src/server/providers/claude/sdk-spawn.ts',
      'src/server/agent-runtime/providers/opencode-sdk.ts'
    ]) {
      assert.doesNotMatch(
        readSrc(site),
        /from ['"].*providers\/spawn['"]/,
        `${site} must not import providers/spawn`
      )
    }

    // Cursor sync probe may still use spawnProviderCommandSync.
    const cursor = readSrc('src/server/agent-runtime/cursor-acp/command.ts')
    assert.match(cursor, /spawnProviderCommandSync/)
    assert.match(cursor, /from ['"].*providers\/spawn['"]/)
  })

  it('spawnProtectedProviderInvocation fail-closes without install', () => {
    uninstallProtectedRuntime()
    assert.throws(
      () =>
        spawnProtectedProviderInvocation(
          { executable: process.execPath, prefixArgs: [] },
          ['-e', 'process.exit(0)'],
          {
            cwd: process.cwd(),
            env: { ...process.env } as Record<string, string>,
            stdio: 'ignore'
          }
        ),
      (error: unknown) => {
        assert.ok(error instanceof ProtectedSpawnError)
        assert.equal(error.code, 'runtime.protected.not_installed')
        return true
      }
    )
  })

  it('spawnProtectedProviderInvocation returns child via live RuntimeAdapter stub', async () => {
    uninstallProtectedRuntime()
    installLiveProtectedRuntimeStub({ providerCode: 'fake' })
    const child = spawnProtectedProviderInvocation(
      { executable: process.execPath, prefixArgs: [] },
      ['-e', 'process.exit(0)'],
      {
        cwd: process.cwd(),
        env: { ...process.env } as Record<string, string>,
        stdio: 'ignore',
        providerCode: 'fake'
      }
    )
    const exitCode = await new Promise<number | null>((resolveExit, reject) => {
      child.once('exit', (code) => resolveExit(code))
      child.once('error', reject)
    })
    assert.equal(exitCode, 0)
    uninstallProtectedRuntime()
  })
})
