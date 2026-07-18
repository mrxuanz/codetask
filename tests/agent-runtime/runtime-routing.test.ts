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

test('permission-changing ordinary chat turns do not reuse Provider sessions', () => {
  const source = readFileSync(join(process.cwd(), 'src/server/conversation/service.ts'), 'utf8')
  assert.match(source, /const phaseRuntimeId = createTaskMode[\s\S]*?: null/)
  assert.match(source, /core\.code === 'cursorcli' && createTaskMode/)
})
