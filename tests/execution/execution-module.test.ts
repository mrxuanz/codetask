import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { Hono } from 'hono'
import type { AgentRuntime } from '@codetask/agent-runtime'
import type { JobSubmission } from '@codetask/contracts'
import {
  composeExecutionModule as composeProductionExecutionModule,
  FakeAgentRuntime
} from '../../packages/server-core/src/modules/execution/index.ts'
import { migration043DesignModuleTables } from '../../packages/database/src/migrations/index.ts'
import { migration045ExecutionModuleTables } from '../../packages/database/src/migrations/execution.ts'
import type { ExecutionHttpEnv } from '../../packages/server-core/src/modules/execution/job/http/job-routes.ts'

function composeExecutionModule(
  deps: Omit<Parameters<typeof composeProductionExecutionModule>[0], 'agentRuntime'> & {
    agentRuntime?: AgentRuntime
  }
): ReturnType<typeof composeProductionExecutionModule> {
  return composeProductionExecutionModule({
    ...deps,
    agentRuntime: deps.agentRuntime ?? new FakeAgentRuntime()
  })
}

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
      workspaceRoot: '/tmp/codetask-exec-test',
      status: 'confirmed',
      lockRevision: 1,
      abilities: [],
      references: [],
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
              dependsOnSliceIds: [],
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
                  referenceReason: '',
                  requiredInputs: [],
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
  it('rejects malformed and structurally invalid command bodies', async () => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    migration043DesignModuleTables.up(db)
    migration045ExecutionModuleTables.up(db)
    const execution = composeExecutionModule({ db })
    const http = new Hono<ExecutionHttpEnv>()
    http.use('*', async (c, next) => {
      c.set('actor', { userId: 'alice', sessionId: 'sess-1' })
      c.set('requestId', 'execution-validation-test')
      await next()
    })
    http.route('/', execution.routes)

    const malformed = await http.request('/jobs/missing/pause', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{'
    })
    assert.equal(malformed.status, 400)
    assert.equal((await malformed.json()).requestId, 'execution-validation-test')

    const invalid = await http.request('/jobs/missing/pause', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedRevision: '0', idempotencyKey: '' })
    })
    assert.equal(invalid.status, 400)

    const unexpectedField = await http.request('/jobs/missing/pause', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedRevision: 0, idempotencyKey: 'idem', debug: true })
    })
    assert.equal(unexpectedField.status, 400)
    execution.drain()
    db.close()
  })

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

  it('promotes draft attachment ownership to the Job and releases it on delete', async () => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    migration043DesignModuleTables.up(db)
    migration045ExecutionModuleTables.up(db)

    const calls: string[] = []
    const execution = composeExecutionModule({
      db,
      assets: {
        prepareReferences(input) {
          calls.push(`prepare:${input.draftId}`)
          return input.references.map((reference) => ({
            ...reference,
            resolvedPath: '/tmp/assets/att-1/reference.png'
          }))
        },
        promoteReferences(input) {
          calls.push(`promote:${input.jobId}:${input.references[0]?.attachmentId}`)
        },
        releaseJob(jobId) {
          calls.push(`release:${jobId}`)
        },
        resolveAttachmentPath() {
          return '/tmp/assets/att-1/reference.png'
        },
        onReferencesReleased() {
          calls.push('cleanup')
        }
      }
    })
    const submission = minimalSubmission()
    const reference = {
      id: 'ref-1',
      source: 'attachment',
      name: 'reference.png',
      kind: 'image' as const,
      mimeType: 'image/png',
      description: 'Reference image',
      attachmentId: 'att-1'
    }
    submission.draftSnapshot.references = [reference]
    submission.referenceManifest.references = [reference]
    submission.executionTree.milestones[0]!.slices[0]!.tasks[0]!.referenceIds = ['ref-1']

    const accepted = await execution.submitJob.accept(submission)
    const snapshot = db
      .prepare(`SELECT reference_manifest_json AS manifest FROM job_snapshots WHERE job_id = ?`)
      .get(accepted.jobId) as { manifest: string }
    assert.match(snapshot.manifest, /\/tmp\/assets\/att-1\/reference\.png/)
    assert.deepEqual(
      calls.slice(0, 2).map((call) => call.split(':')[0]),
      ['prepare', 'promote']
    )

    const actor = { userId: 'alice', sessionId: 'asset-delete' }
    let job = execution.jobs.query.get(actor, accepted.jobId)
    for (let attempt = 0; attempt < 30; attempt += 1) {
      if (['succeeded', 'failed', 'cancelled', 'paused'].includes(job.state)) break
      await execution.scheduler.tick()
      await new Promise((resolve) => setTimeout(resolve, 2))
      job = execution.jobs.query.get(actor, accepted.jobId)
    }
    assert.ok(['succeeded', 'failed', 'cancelled', 'paused'].includes(job.state))
    execution.jobs.delete.delete(actor, accepted.jobId, {
      expectedRevision: job.stateRevision,
      idempotencyKey: 'delete-asset-job'
    })
    assert.ok(calls.includes(`release:${accepted.jobId}`))
    assert.ok(calls.includes('cleanup'))

    execution.drain()
    db.close()
  })
})
