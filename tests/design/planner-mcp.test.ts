/**
 * Design Planner MCP protocol — outline → contexts → finalize → ExecutionTree.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  dispatchPlannerToolForTests,
  registerPlannerMcpSession,
  unregisterPlannerMcpSession,
  type PlannerMcpSession
} from '../../packages/server-core/src/modules/design/planning/mcp/index.ts'
import { registeredPlanToExecutionTree } from '../../packages/server-core/src/modules/design/planning/domain/registered-plan-to-tree.ts'

function minimalOutline(
  abilityCode = 'backend-implementation'
): Parameters<typeof registeredPlanToExecutionTree>[0]['plan'] {
  return {
    milestones: [
      {
        title: 'Ship feature',
        description: 'Deliver the feature',
        successCriteria: 'Feature works',
        slices: [
          {
            title: 'Implement',
            description: 'Build units',
            successCriteria: 'Units land',
            tasks: [
              {
                title: 'Scaffold',
                description: 'Create files',
                taskKind: 'scaffolding',
                abilityCode,
                successCriteria: 'Files exist'
              },
              {
                title: 'Service',
                description: 'Core logic',
                taskKind: 'backend-implementation',
                abilityCode,
                successCriteria: 'Logic works',
                dependsOnTaskRefs: ['m1-s1-t1']
              },
              {
                title: 'Routes',
                description: 'HTTP surface',
                taskKind: 'backend-implementation',
                abilityCode,
                successCriteria: 'Routes respond',
                dependsOnTaskRefs: ['m1-s1-t2']
              }
            ]
          }
        ]
      }
    ]
  }
}

describe('design planner MCP', () => {
  it('finalize_plan commits via PlanningApplicationPort', async () => {
    let committedTreeId: string | null = null
    const sessionId = 'mcp-test-1'
    const draftSnapshot = {
      draftId: 'd1',
      actorId: 'alice',
      projectId: 'p1',
      title: 'Demo',
      summary: 'Summary',
      userFlow: 'flow',
      techStack: 'ts',
      nfr: [] as string[],
      acceptance: [] as [],
      verification: [] as [],
      outOfScope: [] as string[],
      assumptions: [] as string[],
      requirementsMarkdown: '# req',
      requirementsStatus: 'confirmed' as const,
      lockedSections: {},
      workspaceRoot: '/tmp/ws',
      status: 'confirmed' as const,
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
    }
    const referenceManifest = {
      snapshotId: 's1',
      draftId: 'd1',
      draftLockRevision: 1,
      contentHash: 'h',
      references: [],
      createdAt: new Date().toISOString()
    }

    const session: PlannerMcpSession = {
      sessionId,
      planningSessionId: 'plan-1',
      runId: 'run-1',
      fencingToken: 'fence-1',
      allowedAbilityCodes: ['backend-implementation'],
      validReferenceIds: [],
      draftSnapshot,
      referenceManifest,
      defaultCoreCode: 'codex',
      planning: {
        async commitExecutionTree(input) {
          committedTreeId = input.tree.treeId
          assert.equal(input.sessionId, 'plan-1')
          assert.equal(input.fencingToken, 'fence-1')
          assert.ok(input.tree.milestones[0]?.slices[0]?.tasks.length === 3)
        },
        notifyPlannerProgress() {
          // Progress notifications are outside this protocol assertion.
        }
      },
      taskContexts: new Map(),
      planOutline: null
    }

    registerPlannerMcpSession(session)
    try {
      await dispatchPlannerToolForTests(sessionId, 'register_plan_outline', minimalOutline())
      for (const [index, title] of ['Scaffold', 'Service', 'Routes'].entries()) {
        await dispatchPlannerToolForTests(sessionId, 'register_task_context', {
          milestone: 1,
          slice: 1,
          task: index + 1,
          taskTitle: title,
          content: `### Read First\nreq\n### Files\na.ts\n### Constraints\nx\n### Do\n${title}\n### Done When\nok`
        })
      }
      await dispatchPlannerToolForTests(sessionId, 'finalize_plan', {})
      await session.finalizerPromise
      assert.equal(session.planCommitted, true)
      assert.ok(committedTreeId)
    } finally {
      unregisterPlannerMcpSession(sessionId)
    }
  })

  it('registeredPlanToExecutionTree maps coords to stable ids', () => {
    const tree = registeredPlanToExecutionTree({
      planningSessionId: 'plan-1',
      plan: minimalOutline(),
      contexts: new Map([
        ['m1-s1-t1', { taskTitle: 'Scaffold', content: 'ctx1' }],
        ['m1-s1-t2', { taskTitle: 'Service', content: 'ctx2' }],
        ['m1-s1-t3', { taskTitle: 'Routes', content: 'ctx3' }]
      ]),
      defaultCoreCode: 'codex'
    })
    assert.equal(tree.milestones.length, 1)
    assert.equal(tree.milestones[0]!.slices[0]!.tasks.length, 3)
    assert.equal(tree.milestones[0]!.slices[0]!.tasks[1]!.contextMarkdown, 'ctx2')
    assert.ok(tree.milestones[0]!.slices[0]!.tasks[1]!.dependsOnTaskIds.length === 1)
  })
})
