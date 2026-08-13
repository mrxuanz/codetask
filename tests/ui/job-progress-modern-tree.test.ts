import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { JobTreeDto } from '@codetask/contracts'
import type { DesignExecutionTreeSnapshot } from '../../apps/web/src/api/design.ts'
import { mapModernProgressTree } from '../../apps/web/src/lib/modernProgressTree.ts'

describe('buildPlanTree modern snapshots', () => {
  it('keeps Design node ids and provider selections', () => {
    const plan: DesignExecutionTreeSnapshot = {
      treeId: 'tree-1',
      planningSessionId: 'planning-1',
      revision: 3,
      milestones: [
        {
          id: 'milestone-source-id',
          title: 'Milestone',
          description: 'description',
          successCriteria: 'done',
          confirmed: true,
          slices: [
            {
              id: 'slice-source-id',
              milestoneId: 'milestone-source-id',
              title: 'Slice',
              description: 'description',
              successCriteria: 'done',
              dependsOnSliceIds: [],
              confirmed: true,
              tasks: [
                {
                  id: 'task-source-id',
                  sliceId: 'slice-source-id',
                  title: 'Task',
                  description: 'description',
                  taskKind: 'implementation',
                  abilityCode: 'frontend',
                  providerCode: 'codex',
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

    const tree = mapModernProgressTree(plan) ?? []
    assert.equal(tree[0]?.id, 'milestone-source-id')
    assert.equal(tree[0]?.slices[0]?.id, 'slice-source-id')
    assert.equal(tree[0]?.slices[0]?.tasks[0]?.id, 'task-source-id')
    assert.equal(tree[0]?.slices[0]?.tasks[0]?.providerCode, 'codex')
  })

  it('keeps executable work ids for evidence lookup', () => {
    const plan: JobTreeDto = {
      jobId: 'job-1',
      generation: 1,
      milestones: [
        {
          id: 'job-milestone-id',
          sourceMilestoneId: 'source-milestone-id',
          title: 'Milestone',
          description: 'description',
          successCriteria: 'done',
          state: 'running',
          sortOrder: 0,
          slices: [
            {
              id: 'job-slice-id',
              sourceSliceId: 'source-slice-id',
              title: 'Slice',
              description: 'description',
              successCriteria: 'done',
              state: 'running',
              verificationState: 'pending',
              dependsOnSliceIds: [],
              sortOrder: 0,
              workItems: [
                {
                  id: 'work-item-id',
                  jobId: 'job-1',
                  generation: 1,
                  sourceTaskId: 'source-task-id',
                  parentWorkId: null,
                  milestoneId: 'job-milestone-id',
                  sliceId: 'job-slice-id',
                  kind: 'task',
                  taskKind: 'implementation',
                  title: 'Task',
                  description: 'description',
                  contextMarkdown: 'context',
                  abilityCode: 'backend',
                  providerCode: 'opencode',
                  successCriteria: 'done',
                  referenceIds: [],
                  referenceReason: '',
                  requiredInputs: [],
                  canRunInParallel: false,
                  state: 'running',
                  stateRevision: 2,
                  sortOrder: 0
                }
              ]
            }
          ]
        }
      ]
    }

    const tree = mapModernProgressTree(plan) ?? []
    assert.equal(tree[0]?.slices[0]?.tasks[0]?.id, 'work-item-id')
    assert.equal(tree[0]?.slices[0]?.tasks[0]?.executionStatus, 'running')
  })
})
