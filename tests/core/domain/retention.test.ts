import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  computeExpiryMs,
  DEFAULT_RETENTION_POLICY,
  isExpiredArtifactEligible,
  selectEligibleArtifacts,
  ttlMsForKind,
  type RetainedArtifact
} from '../../../src/server/core/domain/retention/index.ts'

describe('retention policy types', () => {
  it('exposes default TTLs', () => {
    assert.ok(DEFAULT_RETENTION_POLICY.rawOutputTtlMs > 0)
    assert.ok(DEFAULT_RETENTION_POLICY.transientArtifactTtlMs > 0)
    assert.ok(DEFAULT_RETENTION_POLICY.completedTaskDetailTtlMs > 0)
    assert.ok(DEFAULT_RETENTION_POLICY.failedTaskDetailTtlMs > 0)
  })

  it('ttlMsForKind selects the matching policy field', () => {
    assert.equal(
      ttlMsForKind(DEFAULT_RETENTION_POLICY, 'raw_output'),
      DEFAULT_RETENTION_POLICY.rawOutputTtlMs
    )
    assert.equal(
      ttlMsForKind(DEFAULT_RETENTION_POLICY, 'transient'),
      DEFAULT_RETENTION_POLICY.transientArtifactTtlMs
    )
    assert.equal(
      ttlMsForKind(DEFAULT_RETENTION_POLICY, 'completed_task_detail'),
      DEFAULT_RETENTION_POLICY.completedTaskDetailTtlMs
    )
    assert.equal(
      ttlMsForKind(DEFAULT_RETENTION_POLICY, 'failed_task_detail'),
      DEFAULT_RETENTION_POLICY.failedTaskDetailTtlMs
    )
  })

  it('computeExpiryMs adds ttl to createdAt', () => {
    const createdAtMs = 1_000_000
    const expires = computeExpiryMs(createdAtMs, DEFAULT_RETENTION_POLICY, 'transient')
    assert.equal(expires, createdAtMs + DEFAULT_RETENTION_POLICY.transientArtifactTtlMs)
  })
})

describe('retention eligibility pure rules', () => {
  const nowMs = 10_000

  it('marks expired artifact eligible', () => {
    const artifact: RetainedArtifact = {
      id: 'a1',
      kind: 'transient',
      expiresAtMs: nowMs - 1,
      deletedAtMs: null
    }
    assert.equal(isExpiredArtifactEligible(artifact, nowMs), true)
  })

  it('marks artifact eligible at exact expiry boundary', () => {
    assert.equal(
      isExpiredArtifactEligible(
        { expiresAtMs: nowMs, deletedAtMs: null },
        nowMs
      ),
      true
    )
  })

  it('does not mark unexpired artifact eligible', () => {
    assert.equal(
      isExpiredArtifactEligible(
        { expiresAtMs: nowMs + 1, deletedAtMs: null },
        nowMs
      ),
      false
    )
  })

  it('does not mark retain-forever (null expiresAt) eligible', () => {
    assert.equal(
      isExpiredArtifactEligible({ expiresAtMs: null, deletedAtMs: null }, nowMs),
      false
    )
  })

  it('does not re-select already deleted artifacts', () => {
    assert.equal(
      isExpiredArtifactEligible(
        { expiresAtMs: nowMs - 100, deletedAtMs: nowMs - 50 },
        nowMs
      ),
      false
    )
  })

  it('selectEligibleArtifacts filters the set', () => {
    const artifacts: RetainedArtifact[] = [
      { id: 'keep-future', kind: 'transient', expiresAtMs: nowMs + 5, deletedAtMs: null },
      { id: 'drop-expired', kind: 'raw_output', expiresAtMs: nowMs - 5, deletedAtMs: null },
      { id: 'keep-forever', kind: 'completed_task_detail', expiresAtMs: null, deletedAtMs: null },
      {
        id: 'keep-deleted',
        kind: 'failed_task_detail',
        expiresAtMs: nowMs - 5,
        deletedAtMs: 1
      }
    ]
    const eligible = selectEligibleArtifacts(artifacts, nowMs)
    assert.deepEqual(
      eligible.map((a) => a.id),
      ['drop-expired']
    )
  })
})
