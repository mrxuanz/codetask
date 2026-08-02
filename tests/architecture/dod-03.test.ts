/**
 * Architecture 03 DoD checklist — isolation and structural contracts.
 * @see docs/架构收口/03-普通对话与共享AgentRuntime.md §22.6 / §23
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  buildConversationScopeId,
  createAgentRuntime,
  type AgentTurnEvent
} from '@codetask/agent-runtime'
import { ScriptedAgentRuntime } from '../../packages/server-core/src/modules/execution/pool/infrastructure/scripted-agent-runtime.ts'
import { AgentRuntimePlannerRunner } from '../../packages/server-core/src/modules/design/planning/application/planner-runner.ts'

const root = join(import.meta.dirname, '../..')

function exists(rel: string): boolean {
  try {
    const st = statSync(join(root, rel))
    return st.isFile() || st.isDirectory()
  } catch {
    return false
  }
}

function walk(dir: string, files: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git') continue
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) walk(full, files)
    else if (/\.(ts|tsx)$/.test(name)) files.push(full)
  }
  return files
}

describe('architecture 03 DoD', () => {
  it('conversation/draft and wizard directories are gone from Conversation path', () => {
    assert.equal(exists('src/server/conversation/draft'), false)
    assert.equal(exists('src/server/wizard'), false)
  })

  it('Conversation module does not import Design or Execution', () => {
    const convRoot = join(root, 'packages/server-core/src/modules/conversation')
    for (const file of walk(convRoot)) {
      const source = readFileSync(file, 'utf8')
      assert.doesNotMatch(source, /modules\/design|modules\/execution/)
      assert.doesNotMatch(source, /propose_task_draft/)
      // createTaskMode / generateDraft may appear only as rejection guards in HTTP routes
      if (!file.endsWith('conversation-routes.ts')) {
        assert.doesNotMatch(source, /createTaskMode|generateDraft/)
      }
    }
  })

  it('Conversation host MCP has no wizard phase coupling', () => {
    const mcpRoot = join(root, 'src/server/conversation/mcp')
    for (const file of walk(mcpRoot)) {
      const source = readFileSync(file, 'utf8')
      assert.doesNotMatch(source, /legacy-wizard|wizardPhase|wizardStage|threads\/service/)
    }
    const history = readFileSync(join(root, 'src/server/conversation/history.ts'), 'utf8')
    assert.doesNotMatch(history, /wizard|createTaskMode|task-launch-draft/)
  })

  it('host threads service and legacy-wizard directories are removed', () => {
    assert.equal(exists('src/server/threads'), false)
    assert.equal(exists('src/server/legacy-wizard'), false)
    assert.equal(exists('src/server/legacy-draft'), false)
  })

  it('AgentRuntime scope is conversation:{id}:provider:{code}', () => {
    assert.equal(
      buildConversationScopeId('c1', 'cursor'),
      'conversation:c1:provider:cursor'
    )
  })

  it('legacy chat/job SSE envelope contracts are removed', () => {
    assert.equal(exists('src/shared/contracts/sse.ts'), false)
  })

  it('AgentRuntimePlannerRunner exercises shared runtime port (Scripted)', async () => {
    const runtime = new ScriptedAgentRuntime(async function* (): AsyncIterable<AgentTurnEvent> {
      yield { type: 'completed', reason: 'completed', reply: 'ok' }
    })
    let committed = false
    const planner = new AgentRuntimePlannerRunner(
      () => ({
        async commitExecutionTree() {
          committed = true
        }
      }),
      runtime,
      { commitEvenIfRuntimeFails: false }
    )
    await planner.run({
      sessionId: 'plan-1',
      runId: 'run-1',
      fencingToken: 'fence-1',
      draftSnapshot: {
        draftId: 'd1',
        actorId: 'alice',
        projectId: 'p1',
        title: 'Demo',
        summary: 'Summary',
        userFlow: 'flow',
        techStack: 'ts',
        nfr: [],
        acceptance: [],
        verification: [],
        outOfScope: [],
        assumptions: [],
        requirementsMarkdown: '# req',
        requirementsStatus: 'confirmed',
        lockedSections: {},
        workspaceRoot: '/tmp/ws',
        status: 'confirmed',
        lockRevision: 1,
        abilities: [
          {
            abilityCode: 'backend-implementation',
            label: 'Backend',
            description: 'impl',
            reason: 'needed',
            recommendedCoreCode: 'codex'
          }
        ],
        references: [],
        executionProfile: {
          plannerCoreCode: 'codex',
          sliceVerifierCoreCode: 'codex',
          milestoneVerifierCoreCode: 'codex'
        },
        capturedAt: new Date().toISOString()
      },
      referenceManifest: {
        snapshotId: 's1',
        draftId: 'd1',
        draftLockRevision: 1,
        contentHash: 'h',
        references: [],
        createdAt: new Date().toISOString()
      },
      executionProfile: { plannerCoreCode: 'codex' }
    })
    assert.equal(runtime.turns.length, 1)
    assert.equal(runtime.turns[0]?.role, 'planner')
    assert.equal(committed, true)
  })

  it('createAgentRuntime is the package entry; create_task absent', () => {
    const source = readFileSync(join(root, 'packages/agent-runtime/src/index.ts'), 'utf8')
    assert.match(source, /export function createAgentRuntime/)
    assert.doesNotMatch(source, /create_task|create-task-read/)
    assert.equal(typeof createAgentRuntime, 'function')
  })

  it('legacy workflow and wizard test suites are retired', () => {
    assert.equal(exists('tests/wizard'), false)
    assert.equal(exists('tests/workflow/01-entry-thread.test.ts'), false)
    assert.equal(exists('tests/workflow/retired-03.test.ts'), true)
  })
})
