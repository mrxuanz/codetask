import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { DesignDraftDto, DesignExecutionTreeSnapshot } from '../../apps/web/src/api/design.ts'
import type { ExecutionJob } from '../../apps/web/src/api/jobs-api.ts'
import {
  mapExecutionJobToPlanView,
  mapPlanningSessionToJob
} from '../../apps/web/src/api/planning-view-mappers.ts'

function executionJob(overrides: Partial<ExecutionJob> = {}): ExecutionJob {
  return {
    id: 'job-1',
    title: 'Build feature',
    summary: 'Ship the feature',
    state: 'running',
    stateRevision: 4,
    controlIntent: 'none',
    executionGeneration: 1,
    projectId: 'project-1',
    actorId: 'actor-1',
    workspaceRoot: '/workspace/project-1',
    queuedAt: '2026-01-01T00:00:00.000Z',
    startedAt: '2026-01-01T00:01:00.000Z',
    terminalAt: null,
    availableActions: ['pause', 'cancel'],
    recoveryReason: null,
    sourceDraftId: 'draft-1',
    sourcePlanningSessionId: 'plan-1',
    currentRunId: 'run-1',
    suspensionKind: null,
    queuePosition: 2,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:02:00.000Z',
    tree: {
      jobId: 'job-1',
      generation: 1,
      milestones: [
        {
          id: 'milestone-1',
          sourceMilestoneId: 'source-milestone-1',
          title: 'Milestone',
          description: 'description',
          successCriteria: 'done',
          state: 'running',
          sortOrder: 0,
          slices: [
            {
              id: 'slice-1',
              sourceSliceId: 'source-slice-1',
              title: 'Slice',
              description: 'description',
              successCriteria: 'done',
              state: 'running',
              verificationState: 'pending',
              dependsOnSliceIds: [],
              sortOrder: 0,
              workItems: [
                {
                  id: 'work-running',
                  jobId: 'job-1',
                  generation: 1,
                  sourceTaskId: 'task-running',
                  parentWorkId: null,
                  milestoneId: 'milestone-1',
                  sliceId: 'slice-1',
                  kind: 'task',
                  taskKind: 'implementation',
                  title: 'Running work',
                  description: 'description',
                  contextMarkdown: 'context',
                  abilityCode: 'frontend',
                  providerCode: 'opencode',
                  successCriteria: 'done',
                  referenceIds: [],
                  referenceReason: '',
                  requiredInputs: [],
                  canRunInParallel: false,
                  state: 'running',
                  stateRevision: 2,
                  sortOrder: 0
                },
                {
                  id: 'work-complete',
                  jobId: 'job-1',
                  generation: 1,
                  sourceTaskId: 'task-complete',
                  parentWorkId: null,
                  milestoneId: 'milestone-1',
                  sliceId: 'slice-1',
                  kind: 'task',
                  taskKind: 'verification',
                  title: 'Completed work',
                  description: 'description',
                  contextMarkdown: 'context',
                  abilityCode: 'backend',
                  providerCode: 'codex',
                  successCriteria: 'done',
                  referenceIds: [],
                  referenceReason: '',
                  requiredInputs: [],
                  canRunInParallel: false,
                  state: 'succeeded',
                  stateRevision: 3,
                  sortOrder: 1
                }
              ]
            }
          ]
        }
      ]
    },
    ...overrides
  }
}

function designDraft(): DesignDraftDto {
  return {
    id: 'draft-1',
    actorId: 'actor-1',
    projectId: 'project-1',
    title: 'Design title',
    summary: 'Design summary',
    userFlow: '',
    techStack: '',
    nfr: [],
    acceptance: [],
    verification: [],
    outOfScope: [],
    assumptions: [],
    requirementsMarkdown: '',
    requirementsStatus: 'confirmed',
    lockedSections: {},
    executionProfile: {
      plannerCoreCode: 'opencode',
      sliceVerifierCoreCode: 'codex',
      milestoneVerifierCoreCode: 'codex'
    },
    workspaceRoot: '/workspace/project-1',
    status: 'confirmed',
    lockRevision: 2,
    createdAt: Date.parse('2026-01-01T00:00:00.000Z'),
    updatedAt: Date.parse('2026-01-01T00:02:00.000Z'),
    abilities: [
      {
        abilityCode: 'frontend',
        label: 'Frontend',
        description: 'Build UI',
        reason: 'Required by the draft',
        recommendedCoreCode: 'opencode'
      }
    ],
    references: []
  }
}

function designTree(): DesignExecutionTreeSnapshot {
  return {
    treeId: 'tree-1',
    planningSessionId: 'plan-1',
    revision: 3,
    milestones: [
      {
        id: 'milestone-1',
        title: 'Milestone',
        description: 'description',
        successCriteria: 'done',
        confirmed: true,
        slices: [
          {
            id: 'slice-1',
            milestoneId: 'milestone-1',
            title: 'Slice',
            description: 'description',
            successCriteria: 'done',
            dependsOnSliceIds: [],
            confirmed: false,
            tasks: [
              {
                id: 'task-1',
                sliceId: 'slice-1',
                title: 'Task',
                description: 'description',
                taskKind: 'implementation',
                abilityCode: 'frontend',
                providerCode: 'opencode',
                contextMarkdown: 'context',
                successCriteria: 'done',
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
  }
}

describe('planning view mappers', () => {
  it('preserves execution state, queue position, providers, and active work', () => {
    const view = mapExecutionJobToPlanView(executionJob())

    assert.equal(view.status, 'running')
    assert.deepEqual(view.queue, { position: 2, ahead: 1 })
    assert.equal(view.taskProgress.currentTaskId, 'work-running')
    assert.deepEqual(
      view.taskProgress.tasks.map((task) => [task.id, task.status, task.providerCode]),
      [
        ['work-running', 'running', 'opencode'],
        ['work-complete', 'completed', 'codex']
      ]
    )
    assert.deepEqual(view.abilities, [
      { abilityCode: 'frontend', recommendedCoreCode: 'opencode' },
      { abilityCode: 'backend', recommendedCoreCode: 'codex' }
    ])
  })

  it('maps terminal execution states to the legacy plan status without fake queue data', () => {
    const view = mapExecutionJobToPlanView(
      executionJob({ state: 'succeeded', queuePosition: null })
    )

    assert.equal(view.status, 'completed')
    assert.equal(view.taskProgress.status, 'completed')
    assert.equal(view.queue, undefined)
  })

  it('derives planning progress and abilities from the frozen design snapshot', () => {
    const view = mapPlanningSessionToJob(
      {
        id: 'plan-1',
        actorId: 'actor-1',
        projectId: 'project-1',
        sourceDraftId: 'draft-1',
        status: 'planning',
        treeRevision: 3,
        publishedJobId: null,
        createdAt: Date.parse('2026-01-01T00:00:00.000Z'),
        updatedAt: Date.parse('2026-01-01T00:02:00.000Z'),
        publishedAt: null
      },
      designTree(),
      designDraft()
    )

    assert.equal(view.title, 'Design title')
    assert.equal(view.workspaceRoot, '/workspace/project-1')
    assert.equal(view.planProgress.contextsRegistered, 2)
    assert.equal(view.planProgress.contextsTotal, 3)
    assert.deepEqual(view.abilities, [
      { abilityCode: 'frontend', label: 'Frontend', recommendedCoreCode: 'opencode' }
    ])
    assert.equal(view.taskProgress.tasks[0]?.id, 'task-1')
  })
})
