import type { JobExecutionProfile } from '../../src/shared/contracts/plan'

export const TEST_JOB_EXECUTION_PROFILE: JobExecutionProfile = {
  plannerCoreCode: 'codex',
  sliceVerifierCoreCode: 'codex',
  milestoneVerifierCoreCode: 'codex',
  skills: {
    planner: {
      skillIds: ['test-planning'],
      instructions: 'Create a concrete execution plan.'
    },
    taskWorker: {
      skillIds: ['test-task-execution'],
      instructions: 'Complete the assigned task and report evidence.'
    },
    sliceVerifier: {
      skillIds: ['test-slice-verification'],
      instructions: 'Verify the slice against its success criteria.'
    },
    milestoneVerifier: {
      skillIds: ['test-milestone-verification'],
      instructions: 'Verify the milestone against its success criteria.'
    }
  }
}

export const TEST_JOB_EXECUTION_PROFILE_JSON = JSON.stringify(TEST_JOB_EXECUTION_PROFILE)
