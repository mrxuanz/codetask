/**
 * Configurable retention TTLs (ms). Domain-only; adapters supply clock + persistence.
 * @see 重构.md §9.5
 */
export interface RetentionPolicy {
  readonly rawOutputTtlMs: number
  readonly transientArtifactTtlMs: number
  readonly completedTaskDetailTtlMs: number
  readonly failedTaskDetailTtlMs: number
}

export const DEFAULT_RETENTION_POLICY: RetentionPolicy = {
  rawOutputTtlMs: 7 * 24 * 60 * 60 * 1000,
  transientArtifactTtlMs: 14 * 24 * 60 * 60 * 1000,
  completedTaskDetailTtlMs: 30 * 24 * 60 * 60 * 1000,
  failedTaskDetailTtlMs: 90 * 24 * 60 * 60 * 1000
}

export type ArtifactRetentionKind =
  | 'raw_output'
  | 'transient'
  | 'completed_task_detail'
  | 'failed_task_detail'

export interface RetainedArtifact {
  readonly id: string
  readonly kind: ArtifactRetentionKind
  /** Absolute expiry instant (ms since epoch). null = retain until explicit delete. */
  readonly expiresAtMs: number | null
  /** Soft-delete marker; already-deleted artifacts are not eligible again. */
  readonly deletedAtMs: number | null
}
