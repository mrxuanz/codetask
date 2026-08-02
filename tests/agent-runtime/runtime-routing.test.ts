import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { OUTER_SANDBOX_ROLES, roleRequiresOuterSandbox } from '../../src/server/agent-runtime/roles'

test('only worker and verifier roles require the outer sandbox', () => {
  assert.deepEqual(OUTER_SANDBOX_ROLES, ['task-worker', 'milestone-verifier', 'slice-verifier'])
  assert.equal(roleRequiresOuterSandbox('conversation'), false)
  assert.equal(roleRequiresOuterSandbox('planner'), false)
})

test('agent runner loads sandbox orchestration only inside the sandbox branch', () => {
  const source = readFileSync(join(process.cwd(), 'src/server/agent-runtime/runner.ts'), 'utf8')
  assert.doesNotMatch(source, /from ['"]\.\.\/sandbox['"]/)
  const branch = source.indexOf('capabilityProfileRequiresOuterSandbox')
  const dynamicImport = source.indexOf("await import('../sandbox/orchestrator')")
  assert.ok(branch >= 0)
  assert.ok(dynamicImport > branch)
})

test('application startup does not require sandbox supervisor readiness', () => {
  const source = readFileSync(join(process.cwd(), 'src/main/server.ts'), 'utf8')
  assert.doesNotMatch(source, /confirmSandboxReadyOrThrow/)
  assert.doesNotMatch(source, /getSandboxSupervisorManager/)
})

test('Cursor task work uses a one-shot sandbox worker and ephemeral ACP runtime', () => {
  const orchestrator = readFileSync(
    join(process.cwd(), 'src/server/sandbox/orchestrator-local.ts'),
    'utf8'
  )
  const worker = readFileSync(join(process.cwd(), 'src/sandbox/role-worker.ts'), 'utf8')
  const lifecycle = readFileSync(join(process.cwd(), 'src/server/providers/lifecycle.ts'), 'utf8')
  const cursorStream = readFileSync(
    join(process.cwd(), 'src/server/agent-runtime/cursor-acp/stream-session-turn.ts'),
    'utf8'
  )

  assert.doesNotMatch(orchestrator, /streamJobCursorSandboxTurn|usePersistentCursorPool/)
  assert.match(orchestrator, /launchSandboxedWorker/)
  assert.match(worker, /getAgentTurnProvider\(input\.provider\)/)
  assert.match(lifecycle, /role !== 'conversation'/)
  assert.match(cursorStream, /const ephemeral = !reusable/)
  assert.match(cursorStream, /await runtime\.close\(\)/)
})

test('Cursor ACP turns have a bounded no-update wait', () => {
  const source = readFileSync(
    join(process.cwd(), 'src/server/agent-runtime/cursor-acp/session-runtime.ts'),
    'utf8'
  )
  assert.match(source, /CURSOR_ACP_UPDATE_IDLE_TIMEOUT_MS/)
  assert.match(source, /provider\.cursor\.acp_keepalive_timeout/)
  assert.match(source, /waitForCursorUpdate/)
})

test('HTTP listen path initializes Conversation MCP after the port is bound', () => {
  const source = readFileSync(join(process.cwd(), 'src/main/server.ts'), 'utf8')
  assert.match(source, /initConversationMcpBackend/)
  assert.match(source, /async function createReadyApp\(/)
  assert.doesNotMatch(source, /scheduleLegacyQueueResume|resumeJobQueuesAfterServerReady/)
})

test('application runtime starts Conversation + Execution modules on ready', () => {
  const source = readFileSync(
    join(process.cwd(), 'src/server/application/host-application-runtime.ts'),
    'utf8'
  )
  assert.match(source, /getOrComposeConversation\(.*\)\.startup\(\)/)
  assert.match(source, /getOrComposeExecution\(.*\)\.startup\(\)/)
})

test('ordinary chat write turns use one-shot Provider reuse (03)', () => {
  const lifecycle = readFileSync(join(process.cwd(), 'src/server/providers/lifecycle.ts'), 'utf8')
  const runtime = readFileSync(join(process.cwd(), 'packages/agent-runtime/src/index.ts'), 'utf8')
  assert.match(lifecycle, /capabilityProfile === 'chat-write'/)
  assert.match(runtime, /capabilityProfile === 'chat-write'/)
  assert.match(runtime, /buildConversationScopeId/)
  assert.doesNotMatch(runtime, /create_task|createTaskMode/)
})
