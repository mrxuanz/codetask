import assert from 'node:assert/strict'
import test from 'node:test'
import { parseJobExecutionProfile } from '../../src/server/execution-profile.ts'

const profile = {
  plannerCoreCode: 'codex',
  sliceVerifierCoreCode: 'claude-code',
  milestoneVerifierCoreCode: 'cursorcli',
  skills: {
    planner: { skillIds: ['planning'], instructions: 'Plan the work.' },
    taskWorker: { skillIds: ['working'], instructions: 'Execute and verify the task.' },
    sliceVerifier: { skillIds: ['slice'], instructions: 'Review slice evidence.' },
    milestoneVerifier: { skillIds: ['milestone'], instructions: 'Review milestone evidence.' }
  }
}

test('execution profile parses as the single current shape without a version field', () => {
  assert.deepEqual(parseJobExecutionProfile(profile), profile)
  assert.equal('version' in profile, false)
  assert.equal(parseJobExecutionProfile({ ...profile, version: 1 }), null)
})

test('execution profile fails closed when a role handbook or supported CLI is missing', () => {
  assert.equal(
    parseJobExecutionProfile({
      ...profile,
      skills: { ...profile.skills, taskWorker: undefined }
    }),
    null
  )
  assert.equal(parseJobExecutionProfile({ ...profile, plannerCoreCode: 'unknown-cli' }), null)
})
