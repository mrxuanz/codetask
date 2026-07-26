import type { ArtifactRetentionKind, RetainedArtifact, RetentionPolicy } from './types'

export function ttlMsForKind(policy: RetentionPolicy, kind: ArtifactRetentionKind): number {
  switch (kind) {
    case 'raw_output':
      return policy.rawOutputTtlMs
    case 'transient':
      return policy.transientArtifactTtlMs
    case 'completed_task_detail':
      return policy.completedTaskDetailTtlMs
    case 'failed_task_detail':
      return policy.failedTaskDetailTtlMs
  }
}

export function computeExpiryMs(
  createdAtMs: number,
  policy: RetentionPolicy,
  kind: ArtifactRetentionKind
): number {
  return createdAtMs + ttlMsForKind(policy, kind)
}

/**
 * Pure eligibility: expired artifacts with no soft-delete are eligible for cleanup.
 * Artifacts without expiresAtMs are retained (not eligible).
 */
export function isExpiredArtifactEligible(
  artifact: Pick<RetainedArtifact, 'expiresAtMs' | 'deletedAtMs'>,
  nowMs: number
): boolean {
  if (artifact.deletedAtMs != null) return false
  if (artifact.expiresAtMs == null) return false
  return artifact.expiresAtMs <= nowMs
}

export function selectEligibleArtifacts(
  artifacts: readonly RetainedArtifact[],
  nowMs: number
): readonly RetainedArtifact[] {
  return artifacts.filter((artifact) => isExpiredArtifactEligible(artifact, nowMs))
}
