import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeTaskEvidencePacket } from '../../src/server/legacy-control-plane/evidence/normalize'
import {
  normalizeChangedFilePath,
  resolveReadablePathWithinWorkspace
} from '../../src/server/legacy-control-plane/evidence/paths'
import { preflightSliceTaskEvidence } from '../../src/server/legacy-control-plane/evidence/preflight'
import { computeSliceEvidenceBundleHash } from '../../src/server/legacy-control-plane/evidence/hash'
import {
  guardVerificationAttempt,
  withVerificationAttempt
} from '../../src/server/legacy-control-plane/verification-attempts'
import type { SavedJobPlan } from '../../src/server/planner/plan-types'
import type { TaskProgressItemDto } from '../../src/server/legacy-control-plane/types'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const basePacket = {
  summary: 'Implemented feature X',
  changedFiles: ['src/app.ts'],
  evidence: ['src/app.ts exports mount()'],
  validation: { ran: true, outcome: 'passed', notes: 'typecheck ok' }
}

test('normalizeTaskEvidencePacket accepts completed with full evidence', () => {
  const packet = normalizeTaskEvidencePacket({
    status: 'completed',
    ...basePacket
  })
  assert.equal(packet.status, 'completed')
  assert.equal(packet.changedFiles[0], 'src/app.ts')
})

test('normalizeTaskEvidencePacket requires blockers for blocked status', () => {
  assert.throws(
    () =>
      normalizeTaskEvidencePacket({
        status: 'blocked',
        summary: 'Waiting for API key',
        evidence: ['No credentials in workspace'],
        validation: { ran: false, outcome: 'not-applicable' }
      }),
    /blockers is required/
  )
})

test('normalizeTaskEvidencePacket accepts blocked with blockers', () => {
  const packet = normalizeTaskEvidencePacket({
    status: 'blocked',
    summary: 'Waiting for API key',
    evidence: ['No credentials in workspace'],
    validation: { ran: false, outcome: 'not-applicable' },
    blockers: ['OPENAI_API_KEY missing']
  })
  assert.deepEqual(packet.blockers, ['OPENAI_API_KEY missing'])
})

test('normalizeTaskEvidencePacket rejects missing evidence array', () => {
  assert.throws(
    () =>
      normalizeTaskEvidencePacket({
        status: 'completed',
        summary: 'done',
        changedFiles: [],
        validation: { ran: false, outcome: 'skipped' }
      }),
    /evidence must be an array of strings/
  )
})

test('normalizeChangedFilePath rejects absolute and .. paths', () => {
  assert.throws(() => normalizeChangedFilePath('/etc/passwd', 0), /relative/)
  assert.throws(() => normalizeChangedFilePath('..\\secret.txt', 0), /\.\./)
  assert.throws(() => normalizeChangedFilePath('src/../../secret.txt', 0), /\.\./)
  assert.equal(normalizeChangedFilePath('src/app.ts', 0), 'src/app.ts')
})

test('resolveReadablePathWithinWorkspace blocks traversal reads', () => {
  const root = mkdtempSync(join(tmpdir(), 'evidence-path-'))
  try {
    writeFileSync(join(root, 'allowed.txt'), 'ok')
    assert.equal(
      resolveReadablePathWithinWorkspace(root, 'allowed.txt')?.endsWith('allowed.txt'),
      true
    )
    assert.equal(resolveReadablePathWithinWorkspace(root, '../outside.txt'), null)
    assert.equal(resolveReadablePathWithinWorkspace(root, 'src/../../outside.txt'), null)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('preflightSliceTaskEvidence flags completed tasks without evidence', () => {
  const plan = {
    milestones: [{ slices: [{ tasks: [{}] }] }],
    tasks: [{ id: 'm1-s1-t1', milestoneIndex: 1, sliceIndex: 1, taskIndex: 1 }]
  } as unknown as SavedJobPlan
  const items: TaskProgressItemDto[] = [
    {
      id: 'm1-s1-t1',
      title: 'Task',
      status: 'completed',
      evidenceStatus: 'basic-facts-ok'
    }
  ]
  const result = preflightSliceTaskEvidence(plan, 'm1-s1', items)
  assert.equal(result.ok, false)
  assert.deepEqual(result.missingTaskIds, ['m1-s1-t1'])
})

test('preflightSliceTaskEvidence passes when evidence is present', () => {
  const plan = {
    milestones: [{ slices: [{ tasks: [{}] }] }],
    tasks: [{ id: 'm1-s1-t1', milestoneIndex: 1, sliceIndex: 1, taskIndex: 1 }]
  } as unknown as SavedJobPlan
  const items: TaskProgressItemDto[] = [
    {
      id: 'm1-s1-t1',
      title: 'Task',
      status: 'completed',
      evidence: {
        status: 'completed',
        summary: 'done',
        changedFiles: [],
        evidence: ['ok'],
        validation: { ran: false, outcome: 'skipped' }
      }
    }
  ]
  const result = preflightSliceTaskEvidence(plan, 'm1-s1', items)
  assert.equal(result.ok, true)
})

test('guardVerificationAttempt rejects unchanged evidence hash', () => {
  const plan = {
    milestones: [{ slices: [{ tasks: [{}] }] }],
    tasks: [{ id: 'm1-s1-t1', milestoneIndex: 1, sliceIndex: 1, taskIndex: 1 }]
  } as unknown as SavedJobPlan
  const items: TaskProgressItemDto[] = [
    {
      id: 'm1-s1-t1',
      title: 'Task',
      status: 'completed',
      evidence: {
        status: 'completed',
        summary: 'done',
        changedFiles: ['src/a.ts'],
        evidence: ['ok'],
        validation: { ran: false, outcome: 'skipped' }
      }
    }
  ]
  const hash = computeSliceEvidenceBundleHash(plan, 'm1-s1', items)
  const progress = withVerificationAttempt(
    { phase: 'running', status: 'running', currentIndex: 1, total: 1, tasks: items },
    'slice',
    'm1-s1',
    1,
    hash
  )
  const guard = guardVerificationAttempt({
    progress,
    scope: 'slice',
    id: 'm1-s1',
    bundleHash: hash
  })
  assert.equal(guard.ok, false)
  assert.equal(guard.reason, 'unchanged-evidence')
})
