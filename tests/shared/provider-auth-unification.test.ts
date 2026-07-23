import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createProviderRegistry } from '../../src/server/providers/composition.ts'
import {
  ProcessHostAuthSource,
  processHostAuthSource,
  processHostEnvironmentSource
} from '../../src/server/host-environment.ts'
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

test('HostAuthSource returns presence only and never secret values (PRU-05-03)', () => {
  const secret = 'host-auth-source-secret-value-pru-05-03'
  const source = new ProcessHostAuthSource({
    snapshot: () =>
      Object.freeze({
        OPENAI_API_KEY: secret,
        EMPTY_KEY: '',
        MISSING_IGNORED: undefined as unknown as string
      })
  })
  const result = source.inspectEnvironmentKeys(['OPENAI_API_KEY', 'EMPTY_KEY', 'ABSENT_KEY'])
  assert.deepEqual(result, [
    { key: 'OPENAI_API_KEY', present: true },
    { key: 'EMPTY_KEY', present: false },
    { key: 'ABSENT_KEY', present: false }
  ])
  const json = JSON.stringify(result)
  assert.ok(!json.includes(secret))
  assert.equal('value' in result[0], false)

  // Default process-backed source is constructible and returns boolean presence.
  const live = processHostAuthSource.inspectEnvironmentKeys(['PATH'])
  assert.equal(live.length, 1)
  assert.equal(live[0]?.key, 'PATH')
  assert.equal(typeof live[0]?.present, 'boolean')
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

test('provider auth preflight probes only: no credential writes, no parent env mutation (PRU-05-08)', () => {
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
          resolvedPath: process.execPath
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

    // Preflight modules must not call writeFile.
    for (const name of ['codex', 'claude', 'cursor', 'opencode'] as const) {
      const source = readFileSync(
        join(process.cwd(), `src/server/providers/${name}/preflight.ts`),
        'utf8'
      )
      assert.doesNotMatch(source, /writeFile(Sync)?\(/)
      assert.match(source, /spawnProviderCommandSync/)
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
