import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import type { JobListResult, JobTreeDto } from '@codetask/contracts'
import { WorkflowHarness } from '../helpers/workflow-harness'
import { HONO_BUSINESS_PHASES, HONO_BUSINESS_ROUTES } from '../helpers/hono-business-routes'

type DraftView = {
  id: string
  lockRevision: number
  status: string
}

type PlanningView = {
  session: {
    id: string
    status: string
  }
  tree: {
    revision: number
    milestones: unknown[]
  } | null
}

async function waitForPlanEditing(
  harness: WorkflowHarness,
  sessionId: string
): Promise<PlanningView> {
  const deadline = Date.now() + 15_000
  let latest: PlanningView | null = null
  while (Date.now() < deadline) {
    latest = await harness.json<PlanningView>(
      'GET',
      HONO_BUSINESS_ROUTES.planningSession(sessionId)
    )
    if (latest.session.status === 'plan_editing' && latest.tree) return latest
    if (latest.session.status === 'failed' || latest.session.status === 'cancelled') break
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`planning did not reach plan_editing: ${JSON.stringify(latest)}`)
}

describe('Hono business lifecycle', () => {
  const harness = new WorkflowHarness()

  beforeEach(async () => {
    await harness.setup()
  })

  afterEach(async () => {
    await harness.drainActiveJobs()
    await harness.teardown()
  })

  it('persists conversation, confirms Design, publishes Execution, and exposes evidence', async () => {
    assert.deepEqual(HONO_BUSINESS_PHASES, [
      'conversation',
      'design',
      'planning',
      'execution',
      'verification',
      'evidence'
    ])
    harness.setScript('conversation:chat:codex:1', {
      reply: '需求已确认：实现一个可创建和列出笔记的服务。',
      mcpCalls: []
    })

    const project = await harness.createProject('Notes service acceptance')
    const conversation = await harness.createThread('chat', 'codex', 'Clarify notes service')
    const turnEvents = await harness.sendMessage(
      conversation.id,
      '请确认需求：用 Hono 实现创建和列出笔记。'
    )
    assert.ok(turnEvents.some((event) => event.event === 'assistant_message'))
    const messages = await harness.listMessages(conversation.id)
    assert.ok(
      messages.some(
        (message) => message.role === 'assistant' && String(message.content).includes('需求已确认')
      )
    )

    let draft = await harness.json<DraftView>('POST', HONO_BUSINESS_ROUTES.drafts, {
      projectId: project.id,
      title: 'Notes service',
      summary: 'Create and list notes through Hono',
      requirementsMarkdown: '# Requirements\n- create a note\n- list notes'
    })
    draft = await harness.json<DraftView>('PATCH', HONO_BUSINESS_ROUTES.draftAbilities(draft.id), {
      expectedRevision: draft.lockRevision,
      abilities: [
        {
          abilityCode: 'backend-implementation',
          label: 'Backend implementation',
          description: 'Implement the Hono business API',
          reason: 'The acceptance flow is API-first',
          recommendedCoreCode: 'codex'
        }
      ]
    })
    draft = await harness.json<DraftView>(
      'PATCH',
      HONO_BUSINESS_ROUTES.draftExecutionProfile(draft.id),
      {
        expectedRevision: draft.lockRevision,
        executionProfile: {
          plannerCoreCode: 'codex',
          sliceVerifierCoreCode: 'codex',
          milestoneVerifierCoreCode: 'codex'
        }
      }
    )
    draft = await harness.json<DraftView>('POST', HONO_BUSINESS_ROUTES.draftConfirm(draft.id), {
      expectedRevision: draft.lockRevision
    })
    assert.equal(draft.status, 'confirmed')

    harness.setScript('planner:0', {
      reply: 'Registered the executable notes-service plan.',
      mcpCalls: [
        {
          tool: 'register_plan_outline',
          args: {
            milestones: [
              {
                title: 'Deliver notes service',
                description: 'Implement the requested Hono business capability',
                successCriteria: 'Create and list note operations are implemented and verified',
                slices: [
                  {
                    title: 'Implement notes API',
                    description: 'Build the business behavior',
                    successCriteria: 'The acceptance behavior is observable',
                    tasks: [
                      {
                        title: 'Define the note data contract',
                        description: 'Define the persisted note shape and repository boundary',
                        taskKind: 'data-modeling',
                        abilityCode: 'backend-implementation',
                        successCriteria:
                          'The note contract has stable identifiers and content fields',
                        canRunInParallel: false
                      },
                      {
                        title: 'Implement note creation',
                        description: 'Implement the Hono operation that creates a note',
                        taskKind: 'backend-implementation',
                        abilityCode: 'backend-implementation',
                        dependsOnTaskRefs: ['m1-s1-t1'],
                        successCriteria: 'A valid note can be created and returned through the API',
                        canRunInParallel: false
                      },
                      {
                        title: 'Implement note listing',
                        description: 'Implement the Hono operation that lists persisted notes',
                        taskKind: 'backend-implementation',
                        abilityCode: 'backend-implementation',
                        dependsOnTaskRefs: ['m1-s1-t2'],
                        successCriteria: 'Created notes are returned by the list operation',
                        canRunInParallel: false
                      }
                    ]
                  }
                ]
              }
            ]
          }
        },
        {
          tool: 'register_task_context',
          args: {
            milestone: 1,
            slice: 1,
            task: 1,
            taskTitle: 'Define the note data contract',
            content:
              '### Read First\nRequirements contract and existing domain conventions.\n### Files\nHono service domain and persistence boundaries.\n### Constraints\nPreserve API envelopes and stable identifiers.\n### Do\nDefine the note entity and repository contract used by create and list operations.\n### Done When\nThe contract represents note identity and content without transport coupling.'
          }
        },
        {
          tool: 'register_task_context',
          args: {
            milestone: 1,
            slice: 1,
            task: 2,
            taskTitle: 'Implement note creation',
            content:
              '### Read First\nThe note data contract and current Hono route conventions.\n### Files\nHono service application and HTTP route boundaries.\n### Constraints\nPreserve authenticated API envelopes and validation behavior.\n### Do\nImplement note creation through the domain repository and expose it through Hono.\n### Done When\nA valid request creates and returns a persisted note.'
          }
        },
        {
          tool: 'register_task_context',
          args: {
            milestone: 1,
            slice: 1,
            task: 3,
            taskTitle: 'Implement note listing',
            content:
              '### Read First\nThe note repository contract and note creation behavior.\n### Files\nHono service query and HTTP route boundaries.\n### Constraints\nPreserve ordering and the shared API response envelope.\n### Do\nImplement note listing against the same repository used by creation.\n### Done When\nThe list operation returns notes previously created through the business API.'
          }
        },
        { tool: 'finalize_plan', args: {} }
      ]
    })

    const planningSession = await harness.json<{ id: string }>(
      'POST',
      HONO_BUSINESS_ROUTES.draftPlanningSession(draft.id),
      { expectedRevision: draft.lockRevision }
    )
    const editable = await waitForPlanEditing(harness, planningSession.id)
    assert.ok(editable.tree)

    const confirmedTree = await harness.json<{ revision: number }>(
      'POST',
      HONO_BUSINESS_ROUTES.planningTreeConfirm(planningSession.id),
      { expectedRevision: editable.tree.revision }
    )

    harness.installDefaultExecutionScripts()

    const published = await harness.json<{ jobId: string; session: { status: string } }>(
      'POST',
      HONO_BUSINESS_ROUTES.planningPublish(planningSession.id),
      {
        expectedRevision: confirmedTree.revision,
        idempotencyKey: 'hono-notes-lifecycle-v1'
      }
    )
    assert.equal(published.session.status, 'published')

    const completed = await harness.waitForJob(
      published.jobId,
      (job) => job.state === 'succeeded',
      20_000
    )
    assert.equal(completed.sourceDraftId, draft.id)
    assert.equal(completed.sourcePlanningSessionId, planningSession.id)

    const jobs = await harness.json<JobListResult>(
      'GET',
      HONO_BUSINESS_ROUTES.jobs('status=completed&page=1&limit=10&q=notes')
    )
    assert.equal(jobs.total, 1)
    assert.equal(jobs.jobs[0]?.id, published.jobId)

    const jobTree = await harness.json<JobTreeDto>(
      'GET',
      HONO_BUSINESS_ROUTES.jobTree(published.jobId)
    )
    const work = jobTree.milestones[0]?.slices[0]?.workItems[0]
    assert.ok(work)
    assert.equal(work.state, 'succeeded')

    const evidence = await harness.json<{
      status: string
      summary: string
      changedFiles: string[]
    }>('GET', HONO_BUSINESS_ROUTES.jobEvidence(published.jobId, work.id))
    assert.equal(evidence.status, 'completed')
    assert.match(evidence.summary, /Task completed with evidence/)
    assert.deepEqual(evidence.changedFiles, ['src/demo.ts'])

    const verifications = await harness.json<Array<{ scopeType: string; status: string }>>(
      'GET',
      HONO_BUSINESS_ROUTES.jobVerifications(published.jobId)
    )
    assert.ok(verifications.some((item) => item.scopeType === 'slice'))
    assert.ok(verifications.some((item) => item.scopeType === 'milestone'))
  })
})
