import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { buildLaunchEnv, buildLaunchSpec } from '../../src/server/providers/launch-env.ts'

const ROOT = process.cwd()
const TEST_CODEX_INSTALLATION = {
  id: 'codex:test-launch',
  provider: 'codex' as const,
  command: process.execPath,
  source: 'app-config' as const,
  invocation: { executable: process.execPath, prefixArgs: [] },
  resolvedPath: process.execPath
}

function readSource(...segments: string[]): string {
  return readFileSync(join(ROOT, ...segments), 'utf8')
}

// H6-05 / H7-07 — cancel one job turn does not abort unrelated jobs
test('orchestrator scopes cancellation to a single jobId', () => {
  const source = readSource('src/server/sandbox/orchestrator.ts')
  assert.match(source, /const activeJobTurns = new Map/)
  assert.match(source, /function registerJobTurn\(jobId: string/)
  assert.match(source, /function abortJobTurns\(jobId: string/)
  assert.match(source, /activeJobTurns\.get\(jobId\)/)
  assert.match(source, /cancel-job-turns', jobId: trimmed/)
})

test('launcher cancellation tests cover per-turn abort without global kill', () => {
  const source = readSource('tests/sandbox/launcher-cancellation.test.ts')
  assert.match(source, /reapSandboxChild cancellation kills but leaves handle closing/)
  assert.match(source, /launchSandboxedWorker rejects an already-aborted turn/)
})

// H6-07 / H7-10 — completed only after worker reap
test('orchestrator-local reaps child after stdout drain before surfacing exit errors', () => {
  const source = readSource('src/server/sandbox/orchestrator-local.ts')
  const reapIdx = source.indexOf('reapSandboxChild')
  const completedIdx = source.indexOf("chunk.type === 'completed'")
  assert.ok(reapIdx > 0)
  assert.ok(completedIdx > 0)
  assert.ok(
    source.indexOf('reaping child after stdout read') > completedIdx,
    'reap must follow completed handling in readWorkerJsonl'
  )
})

test('supervisor client buffers completed until exit confirms cleanup', () => {
  const source = readSource('src/server/sandbox/supervisor-client.ts')
  assert.match(source, /bufferedCompleted/)
  assert.match(source, /worker cleanup \(stderr drain \+ process reap\)/)
})

test('orchestrator-turns pins completed-after-reap supervisor contract', () => {
  const source = readSource('tests/sandbox/orchestrator-turns.test.ts')
  assert.match(
    source,
    /supervisor client publishes completed only after worker cleanup exits successfully/
  )
})

// H6-08 / H7-11 — dependency-human pauses, does not infra-retry
test('dependency-human recovery pauses instead of scheduling infra-retry', () => {
  const source = readSource('src/server/legacy-control-plane/task-blocker/recovery.ts')
  const humanBlock = source.slice(source.indexOf("classification.kind === 'dependency-human'"))
  assert.match(humanBlock, /action: 'pause-human'/)
  assert.doesNotMatch(humanBlock.slice(0, 400), /infra-retry/)
})

// H6-09 / H7-09 — one-shot work never enters the reusable Cursor ACP pool
test('RuntimeManager makes sandbox job Cursor turns one-shot and ephemeral', () => {
  const worker = readSource('src/sandbox/role-worker.ts')
  const manager = readSource('src/server/providers/lifecycle.ts')
  const stream = readSource('src/server/agent-runtime/cursor-acp/stream-session-turn.ts')
  assert.match(worker, /getAgentTurnProvider\(input\.provider\)/)
  assert.doesNotMatch(worker, /closeJobCursorRuntime/)
  assert.match(manager, /reusePolicy === 'one-shot'/)
  assert.match(stream, /const ephemeral = !reusable/)
  assert.match(stream, /await runtime\.close\(\)/)
  const orchestrator = readSource('src/server/sandbox/orchestrator-local.ts')
  assert.match(orchestrator, /fresh sandbox worker/)
  assert.doesNotMatch(orchestrator, /usePersistentCursorPool|streamJobCursorSandboxTurn/)
})

// H6-10 — only manager-selected conversation scopes may enter the reusable pool
test('conversation Cursor reuse follows ProviderRuntimeScope selected by RuntimeManager', () => {
  const registry = readSource('src/server/agent-runtime/cursor-acp/runtime-registry.ts')
  assert.match(registry, /buildConversationCursorRuntimeScope/)
  const stream = readSource('src/server/agent-runtime/cursor-acp/stream-session-turn.ts')
  assert.match(stream, /input\.providerRuntimeScope/)
  assert.match(stream, /reusePolicy === 'conversation-scoped'/)
  const cursorDriver = readSource('src/server/providers/cursor/driver.ts')
  assert.match(cursorDriver, /ProviderRuntimeManager selects one-shot vs conversation reuse/)
  assert.match(cursorDriver, /getCursorProviderRuntimeRegistry/)
  const conversation = readSource('src/server/conversation/service.ts')
  assert.match(conversation, /providerRuntimeScopeId/)
})

// H6-02 / H7-05 — preflight failure must not write credential files
test('provider auth preflight probes only and never writes credential files', () => {
  const spawnSource = readSource('src/server/providers/spawn.ts')
  const driver = readSource('src/server/providers/driver.ts')
  const providerPreflights = [
    readSource('src/server/providers/codex/preflight.ts'),
    readSource('src/server/providers/claude/preflight.ts'),
    readSource('src/server/providers/cursor/preflight.ts'),
    readSource('src/server/providers/opencode/preflight.ts')
  ]
  assert.match(driver, /preflight\(context:/)
  assert.match(spawnSource, /shell:\s*false/)
  for (const source of providerPreflights) {
    assert.match(source, /spawnProviderCommandSync/)
    assert.doesNotMatch(source, /writeFile(Sync)?\(/)
    assert.match(source, /throw new ProviderAuthError/)
  }
})

// H6-04 / H7-06 — LaunchSummary redaction contract
test('LaunchSummary envVars never embed raw secret values', () => {
  const secret = 'hats-lifecycle-redaction-pin-secret'
  const env = buildLaunchEnv({
    provider: 'codex',
    hostEnv: { PATH: '/usr/bin' },
    providerOverlay: { OPENAI_API_KEY: secret }
  })
  const spec = buildLaunchSpec('codex', {
    cwd: '/tmp/workspace',
    env,
    providerOverlay: { OPENAI_API_KEY: secret },
    installation: TEST_CODEX_INSTALLATION
  })
  const json = JSON.stringify(spec.redactedSummary)
  assert.ok(!json.includes(secret))
  for (const entry of spec.redactedSummary.envVars) {
    assert.equal('value' in entry, false)
  }
})

// H7-01 — Codex and Claude launches assemble independent env snapshots
test('buildLaunchEnv isolates concurrent provider overlays', () => {
  const host = { PATH: '/usr/bin', SHARED: 'host' }
  const codex = buildLaunchEnv({
    provider: 'codex',
    hostEnv: host,
    providerOverlay: { OPENAI_API_KEY: 'codex-key-a' }
  })
  const claude = buildLaunchEnv({
    provider: 'claude-code',
    hostEnv: host,
    providerOverlay: { ANTHROPIC_API_KEY: 'claude-key-b' }
  })
  assert.equal(codex.OPENAI_API_KEY, 'codex-key-a')
  assert.equal('ANTHROPIC_API_KEY' in codex, false)
  assert.equal(claude.ANTHROPIC_API_KEY, 'claude-key-b')
  assert.equal('OPENAI_API_KEY' in claude, false)
})

// H7-02 — two Codex launches with different cwd/env stay independent
test('two Codex launch specs keep distinct cwd and task overlays', () => {
  const specA = buildLaunchSpec('codex', {
    cwd: '/workspace/a',
    installation: TEST_CODEX_INSTALLATION,
    taskOverlay: { CODETASK_TASK_IDEMPOTENCY_KEY: 'task-a' }
  })
  const specB = buildLaunchSpec('codex', {
    cwd: '/workspace/b',
    installation: TEST_CODEX_INSTALLATION,
    taskOverlay: { CODETASK_TASK_IDEMPOTENCY_KEY: 'task-b' }
  })
  assert.equal(specA.cwd, '/workspace/a')
  assert.equal(specB.cwd, '/workspace/b')
  assert.notEqual(specA.env, specB.env)
})

// H7-03 — mutating one launch env does not affect the next build
test('mutating a Codex launch env does not leak into a subsequent build', () => {
  const host = { STABLE: 'yes' }
  const first = buildLaunchEnv({ provider: 'codex', hostEnv: host })
  const second = buildLaunchEnv({ provider: 'codex', hostEnv: host })
  first.STABLE = 'mutated'
  assert.equal(second.STABLE, 'yes')
})

// H7-08 — buildLaunchSpec must not write process.env (see also provider-launch-env.test.ts)
test('buildLaunchSpec does not assign to process.env', () => {
  const key = 'CODETASK_LAUNCH_SPEC_PIN'
  const previous = process.env[key]
  delete process.env[key]
  try {
    buildLaunchSpec('codex', {
      cwd: '/tmp',
      installation: TEST_CODEX_INSTALLATION,
      taskOverlay: { [key]: 'would-leak' }
    })
    assert.equal(process.env[key], previous)
  } finally {
    if (previous === undefined) delete process.env[key]
    else process.env[key] = previous
  }
})

// H8-01..04 — orchestrator turn path consumes LaunchSpec for diagnostics
test('orchestrator-local logs redacted launch-spec after provider auth preflight', () => {
  const source = readSource('src/server/sandbox/orchestrator-local.ts')
  assert.match(source, /buildLaunchSpec/)
  assert.match(source, /sandboxTurnDebug\('launch-spec'/)
  assert.match(source, /redactedSummary/)
})
