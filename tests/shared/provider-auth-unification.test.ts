import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createProviderRegistry } from '../../src/server/providers/composition.ts'
import { processHostEnvironmentSource } from '../../src/server/host-environment.ts'
import { toProviderAuthLogDto } from '../../src/server/sandbox/provider-auth/types.ts'
import { spawnProviderCommandSync } from '../../src/server/providers/spawn.ts'
import { resolveProviderRunPolicy } from '../../src/server/agent-runtime/provider-policy.ts'

test('ProviderRegistry driver is the only complete production runtime entry (PRU-04-03)', () => {
  for (const provider of createProviderRegistry().list()) {
    assert.equal(provider.kind, 'production')
    assert.equal(typeof provider.discover, 'function')
    assert.equal(typeof provider.prepareAuth, 'function')
    assert.equal(typeof provider.preflight, 'function')
    assert.equal(typeof provider.prepareTurn, 'function')
  }
})

test('ProviderAuthMode is only runtime-copy | host-identity (PRU-05-01)', () => {
  assert.equal(
    resolveProviderRunPolicy({ outerSandbox: true, runtimeRoot: '/r' }).authMode,
    'runtime-copy'
  )
  assert.equal(
    resolveProviderRunPolicy({ outerSandbox: false, runtimeRoot: '/r' }).authMode,
    'host-identity'
  )
  const policySource = readFileSync(
    join(process.cwd(), 'src/server/agent-runtime/provider-policy.ts'),
    'utf8'
  )
  assert.doesNotMatch(policySource, /host-identity-dev-only|env-token/)
})

test('toProviderAuthLogDto never embeds forged tokens or host paths (PRU-05-06)', () => {
  const forged = 'sk-forged-token-must-not-appear-in-logs'
  const dto = toProviderAuthLogDto({
    provider: 'codex',
    mode: 'runtime-copy',
    authMaterialPresent: true,
    hostAuthPath: `/Users/secret-home/.codex/auth.json`,
    runtimeAuthPath: `/tmp/runtime/.codex/auth.json`,
    warnings: [`token=${forged}`, 'Codex auth snapshotted']
  })
  const json = JSON.stringify(dto)
  assert.ok(!json.includes(forged))
  assert.ok(!json.includes('secret-home'))
  assert.ok(!json.includes('auth.json'))
  assert.deepEqual(dto, {
    provider: 'codex',
    mode: 'runtime-copy',
    authMaterialPresent: true,
    warningCount: 2
  })

  const orchestrator = readFileSync(
    join(process.cwd(), 'src/server/sandbox/orchestrator-local.ts'),
    'utf8'
  )
  assert.match(orchestrator, /toProviderAuthLogDto/)
  assert.equal(
    existsSync(join(process.cwd(), 'src/server/sandbox/provider-auth/preflight.ts')),
    false
  )
})

test('provider auth preflight is read-only: no credential writes or parent env mutation (PRU-05-08)', () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), 'pru-05-08-preflight-'))
  const markerKey = 'CODETASK_PRU_0508_PARENT_ENV'
  const previous = process.env[markerKey]
  delete process.env[markerKey]

  const spawnSource = readFileSync(join(process.cwd(), 'src/server/providers/spawn.ts'), 'utf8')
  assert.match(spawnSource, /shell:\s*false/)

  try {
    const driver = createProviderRegistry().get('codex')
    const prepared = driver.prepareAuth({
      runtimeRoot,
      workspaceRoot: runtimeRoot,
      hostEnvironment: processHostEnvironmentSource.snapshot()
    })
    // Plant a fake host-visible secret in the parent env after prepare — preflight must not write it.
    process.env[markerKey] = 'should-not-leak-into-credential-files'

    const beforeFiles = new Set<string>()
    // Capture whether auth.json exists under runtime after prepare (materialize may create snapshots).
    // Preflight itself must not create additional credential files.
    const authJson = join(runtimeRoot, '.codex', 'auth.json')
    try {
      beforeFiles.add(readFileSync(authJson, 'utf8'))
    } catch {
      beforeFiles.add('__missing__')
    }

    // Skip probe when CLI missing; still exercise the logging/control path.
    try {
      driver.preflight({
        preparedAuth: prepared,
        installation: {
          id: 'codex:test-preflight',
          provider: 'codex',
          command: process.execPath,
          source: 'app-config',
          invocation: { executable: process.execPath, prefixArgs: [] },
          resolvedPath: process.execPath,
          canonicalPath: process.execPath
        }
      })
    } catch {
      // Missing CLI / auth is acceptable — we only assert side effects below.
    }

    assert.equal(process.env[markerKey], 'should-not-leak-into-credential-files')

    let afterContent = '__missing__'
    try {
      afterContent = readFileSync(authJson, 'utf8')
    } catch {
      afterContent = '__missing__'
    }
    assert.equal(afterContent, [...beforeFiles][0])
    assert.ok(!afterContent.includes('should-not-leak-into-credential-files'))

    // Preflight modules must not call writeFile. External-CLI providers may
    // probe their selected executable; SDK-bundled providers validate the
    // authoritative runtime auth snapshot without probing a different host CLI.
    for (const name of ['codex', 'claude', 'cursor', 'opencode'] as const) {
      const source = readFileSync(
        join(process.cwd(), `src/server/providers/${name}/preflight.ts`),
        'utf8'
      )
      assert.doesNotMatch(source, /writeFile(Sync)?\(/)
      if (name === 'cursor' || name === 'opencode') {
        assert.match(source, /spawnProviderCommandSync/)
      } else {
        assert.doesNotMatch(source, /spawnProviderCommandSync/)
        assert.match(source, /authMaterialPresent/)
      }
    }

    // spawn gateway rejects shell:true overrides by construction (options omit shell).
    const result = spawnProviderCommandSync(
      { executable: process.execPath, prefixArgs: [] },
      ['-e', 'process.exit(0)'],
      { timeout: 5_000, env: { PATH: process.env.PATH ?? '' } }
    )
    assert.equal(result.status, 0)
  } finally {
    if (previous === undefined) delete process.env[markerKey]
    else process.env[markerKey] = previous
    try {
      rmSync(runtimeRoot, { recursive: true, force: true })
    } catch {
      // ignore
    }
  }
})
