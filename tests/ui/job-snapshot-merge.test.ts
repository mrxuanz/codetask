import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { JobTreeDto } from '@codetask/contracts'
import type { ExecutionJob } from '../../apps/web/src/api/jobs-api.ts'
import { mergeExecutionJobSnapshot } from '../../apps/web/src/lib/mergeExecutionJob.ts'

function job(stateRevision: number, tree?: JobTreeDto): ExecutionJob & { tree?: JobTreeDto } {
  return {
    id: 'job-1',
    title: 'Job',
    summary: '',
    state: 'running',
    stateRevision,
    controlIntent: 'none',
    executionGeneration: 0,
    projectId: 'project-1',
    actorId: 'alice',
    workspaceRoot: '/tmp/project',
    queuedAt: null,
    startedAt: null,
    terminalAt: null,
    availableActions: ['pause', 'cancel'],
    recoveryReason: null,
    sourceDraftId: 'draft-1',
    sourcePlanningSessionId: 'planning-1',
    currentRunId: 'run-1',
    suspensionKind: null,
    queuePosition: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...(tree ? { tree } : {})
  }
}

function tree(workState: 'pending' | 'succeeded'): JobTreeDto {
  return {
    jobId: 'job-1',
    generation: 0,
    milestones: [
      {
        id: 'milestone-1',
        sourceMilestoneId: 'source-milestone-1',
        title: 'Milestone',
        description: '',
        successCriteria: '',
        state: 'pending',
        sortOrder: 0,
        slices: [
          {
            id: 'slice-1',
            sourceSliceId: 'source-slice-1',
            title: 'Slice',
            description: '',
            successCriteria: '',
            state: 'pending',
            verificationState: 'pending',
            dependsOnSliceIds: [],
            sortOrder: 0,
            workItems: [
              {
                id: 'work-1',
                jobId: 'job-1',
                generation: 0,
                sourceTaskId: 'task-1',
                parentWorkId: null,
                milestoneId: 'milestone-1',
                sliceId: 'slice-1',
                kind: 'task',
                taskKind: 'implementation',
                title: 'Work',
                description: '',
                contextMarkdown: '',
                abilityCode: 'general',
                providerCode: 'opencode',
                successCriteria: '',
                referenceIds: [],
                referenceReason: '',
                requiredInputs: [],
                canRunInParallel: false,
                state: workState,
                stateRevision: workState === 'pending' ? 0 : 1,
                sortOrder: 0
              }
            ]
          }
        ]
      }
    ]
  }
}

describe('mergeExecutionJobSnapshot', () => {
  it('accepts a same Job revision when nested work progress changed', () => {
    const merged = mergeExecutionJobSnapshot(job(2, tree('pending')), job(2, tree('succeeded')))
    assert.equal(merged.tree?.milestones[0]?.slices[0]?.workItems[0]?.state, 'succeeded')
  })

  it('preserves a loaded detail tree when a same-revision list snapshot arrives', () => {
    const merged = mergeExecutionJobSnapshot(job(2, tree('succeeded')), job(2))
    assert.equal(merged.tree?.milestones[0]?.slices[0]?.workItems[0]?.state, 'succeeded')
  })

  it('ignores stale snapshots', () => {
    const current = job(3, tree('succeeded'))
    assert.equal(mergeExecutionJobSnapshot(current, job(2, tree('pending'))), current)
  })
})
