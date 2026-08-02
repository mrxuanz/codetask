import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import type { JobSubmission } from '@codetask/contracts'
import { composeExecutionModule } from '../../packages/server-core/src/modules/execution/index.ts'
import { migration043DesignModuleTables } from '../../packages/database/src/migrations/index.ts'
import { migration045ExecutionModuleTables } from '../../packages/database/src/migrations/execution.ts'

function minimalSubmission(): JobSubmission {
  const now = new Date().toISOString()
  return {
    submissionId: 'sub_exec_test_1',
    idempotencyKey: 'idem_exec_test_1',
    actorId: 'alice',
    projectId: 'proj-1',
    title: 'Execution module smoke',
    summary: 'One-task job',
    workspaceRoot: '/tmp/codetask-exec-test',
    source: { draftId: 'draft-1', planningSessionId: 'plan-1' },
    draftSnapshot: {
      draftId: 'draft-1',
      actorId: 'alice',
      projectId: 'proj-1',
      title: 'Execution module smoke',
      summary: 'One-task job',
      userFlow: '',
      techStack: '',
      nfr: [],
      acceptance: [],
      verification: [],
      outOfScope: [],
      assumptions: [],
      requirementsMarkdown: '# Req',
      requirementsStatus: 'confirmed',
      lockedSections: {},
      executionProfile: {
        plannerCoreCode: 'opencode',
        sliceVerifierCoreCode: 'opencode',
        milestoneVerifierCoreCode: 'opencode'
      },
      capturedAt: now
    },
    referenceManifest: {
      snapshotId: 'snap-1',
      draftId: 'draft-1',
      draftLockRevision: 1,
      contentHash: 'hash-1',
      references: [],
      createdAt: now
    },
    executionProfile: {
      plannerCoreCode: 'opencode',
      sliceVerifierCoreCode: 'opencode',
      milestoneVerifierCoreCode: 'opencode'
    },
    executionSettings: {
      settingsHash: 'settings-1',
      capturedAt: now,
      payload: {}
    },
    executionTree: {
      treeId: 'tree-1',
      planningSessionId: 'plan-1',
      revision: 1,
      milestones: [
        {
          id: 'ms-1',
          title: 'Milestone',
          description: 'Do one thing',
          successCriteria: 'Done',
          confirmed: true,
          slices: [
            {
              id: 'sl-1',
              milestoneId: 'ms-1',
              title: 'Slice',
              description: 'Slice work',
              successCriteria: 'Slice done',
              confirmed: true,
              tasks: [
                {
                  id: 'task-1',
                  sliceId: 'sl-1',
                  title: 'Task',
                  description: 'Implement',
                  taskKind: 'implementation',
                  abilityCode: 'general',
                  coreCode: 'opencode',
                  contextMarkdown: 'context',
                  successCriteria: 'Task done',
                  referenceIds: [],
                  dependsOnTaskIds: [],
                  canRunInParallel: false,
                  confirmed: true
                }
              ]
            }
          ]
        }
      ]
    },
    createdAt: now
  }
}

describe('execution module', () => {
  it('submit → list queued → tick to succeeded with FakeAgentRuntime', async () => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    migration043DesignModuleTables.up(db)
    migration045ExecutionModuleTables.up(db)

    const execution = composeExecutionModule({ db })
    execution.startup()

    const actor = { userId: 'alice', sessionId: 'sess-1' }
    const accepted = await execution.submitJob.accept(minimalSubmission())
    assert.ok(accepted.jobId)

    const listed = execution.jobs.query.list(actor)
    assert.equal(listed.length, 1)
    assert.equal(listed[0]?.id, accepted.jobId)
    assert.ok(['queued', 'running'].includes(listed[0]?.state ?? ''))

    let finalState = listed[0]?.state
    for (let i = 0; i < 30; i += 1) {
      await execution.scheduler.tick()
      finalState = execution.jobs.query.get(actor, accepted.jobId).state
      if (finalState === 'succeeded') break
      await new Promise((resolve) => setTimeout(resolve, 5))
    }

    assert.equal(finalState, 'succeeded')
    execution.drain()
    await new Promise((resolve) => setTimeout(resolve, 20))
    db.close()
  })
})
